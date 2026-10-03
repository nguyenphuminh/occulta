// Channels between wallets over libp2p (through a relay) against real contracts on the dev node:
// opening, off-chain payments, the tie-breaker, cooperative close and the three dispute scenarios.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import { parseEther } from 'viem';
import { createRelayNode } from '../../packages/framework/src/libp2p.node.ts';
import { ChainAdapter } from '../../packages/framework/src/modules/chain/index.ts';
import { balanceOf, hashOf, sideOf, type ChannelRecord } from '../../packages/framework/src/modules/channel/index.ts';
import { channelSecrets, shieldedAddressOf } from '../../packages/framework/src/modules/keys/index.ts';
import { signStateHash } from '../../packages/framework/src/shared/protocol/index.ts';
import { freshDeployment, mineBlock } from './chain.ts';
import { devNetwork, newChannelNode, newRelayer, newUser, type ChannelNode, type User } from './services.ts';

const ETH = 0n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  throw new Error('expected an error');
};

describe('channels on the dev node', () => {
  const fees = { eth: parseEther('0.0001'), usdg: 10_000n };
  let chain: ChainAdapter;
  let relay: Libp2p;
  let relayer: Awaited<ReturnType<typeof newRelayer>>;
  let alice: User;
  let bob: User;
  let carol: User;
  let a: ChannelNode;
  let b: ChannelNode;
  let c: ChannelNode;

  const invite = async (user: User, node: ChannelNode) => node.p2p.invite(shieldedAddressOf(await user.keys.poolKeys()));
  const shielded = (user: User) => user.pool.balances().get(ETH) ?? 0n;
  /** Bob's channels as they were when he joined them. */
  const joined: unknown[] = [];
  const mine = (r: ChannelRecord) => balanceOf(r.latest.state, sideOf(r));
  /** Opens an ETH channel A→B that both fund, and ticks until it is live on both sides. */
  const openLive = async (window: bigint, amount = parseEther('0.1'), peerAmount = parseEther('0.05')): Promise<string> => {
    const before = shielded(alice);
    let accepted: unknown = null;
    const onAccepted = (channelId: string) => (accepted = { channelId, status: a.channels.get(channelId).status, balance: shielded(alice) });
    const opened = await a.channels.open(await invite(bob, b), { token: ETH, amount, peerAmount, window, relayer: relayer.port, onAccepted });
    // A hears of the accepted channel once it is saved, before she funds it; B heard of it once he saved it.
    expect(accepted).toEqual({ channelId: opened.id, status: 'opening', balance: before });
    expect(joined.at(-1)).toEqual({ channelId: opened.id, status: 'opening' });
    expect(await b.channels.tick(relayer.port)).toEqual([]);
    expect(await a.channels.tick(relayer.port)).toEqual([]);
    expect(a.channels.get(opened.id).status).toBe('live');
    expect(b.channels.get(opened.id).status).toBe('live');
    return opened.id;
  };
  const sameLatest = (id: string) => {
    const [ra, rb] = [a.channels.get(id), b.channels.get(id)];
    expect(hashOf(ra, ra.latest.state)).toBe(hashOf(rb, rb.latest.state));
    return ra.latest.state;
  };
  /** Waits past a dispute deadline (the dev node's clock moves only when a block is mined). */
  const passDeadline = async (seconds: bigint) => {
    await sleep(Number(seconds) * 1000 + 1500);
    await mineBlock();
  };

  beforeAll(async () => {
    const network = devNetwork(await freshDeployment());
    chain = new ChainAdapter(network);
    relayer = await newRelayer(network, chain, fees);
    relay = await createRelayNode({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] });
    const relayAddr = relay.getMultiaddrs()[0]!.toString();
    [alice, bob, carol] = [await newUser(network, chain, '3'), await newUser(network, chain, '2'), await newUser(network, chain, '1')];
    await alice.pool.deposit(ETH, parseEther('1'));
    await bob.pool.deposit(ETH, parseEther('0.5'));
    await carol.pool.deposit(ETH, parseEther('0.2'));
    a = await newChannelNode(alice, chain, relayAddr);
    b = await newChannelNode(bob, chain, relayAddr, { approveOpen: async () => true, onJoined: (channelId) => joined.push({ channelId, status: b.channels.get(channelId).status }) });
    c = await newChannelNode(carol, chain, relayAddr);
  });

  afterAll(async () => {
    await Promise.all([a, b, c].filter(Boolean).map((n) => n.p2p.stop()));
    await relay?.stop();
  });

  describe('cooperative lifecycle', () => {
    let id: string;

    it('opens a channel both sides fund; it is live once both contributions are in the pool', async () => {
      const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
      id = await openLive(600n);
      const r = a.channels.get(id);
      expect(r.latest.state.nonce).toBeGreaterThan(r.state0.state.nonce);
      expect(r.latest.state).toMatchObject({ balA: parseEther('0.1') - fees.eth, balB: parseEther('0.05'), closingFee: fees.eth, final: false });
      sameLatest(id);
      // Funding is an ordinary transfer: contribution out, relayer fee paid from change.
      expect(shielded(alice)).toBe(aliceBefore - parseEther('0.1') - fees.eth);
      await bob.pool.sync();
      expect(shielded(bob)).toBe(bobBefore - parseEther('0.05') - fees.eth);
    });

    it('pays both ways without any on-chain transaction', async () => {
      const block = await chain.latestBlock();
      await a.channels.pay(id, parseEther('0.01'));
      await b.channels.pay(id, parseEther('0.003'));
      await a.channels.pay(id, parseEther('0.002'));
      const s = sameLatest(id);
      expect(s.balA).toBe(parseEther('0.1') - fees.eth - parseEther('0.009'));
      expect(s.balB).toBe(parseEther('0.059'));
      expect(await chain.latestBlock()).toBe(block);
      expect(await code(a.channels.pay(id, parseEther('5')))).toBe('INSUFFICIENT_FUNDS');
    });

    it('settles simultaneous proposals with the tie-breaker; both payments go through', async () => {
      const before = sameLatest(id);
      const history = a.channels.get(id).history.length;
      await Promise.all([a.channels.pay(id, 1000n), b.channels.pay(id, 2500n)]);
      const after = sameLatest(id);
      expect(after.balB - before.balB).toBe(-1500n);
      expect(a.channels.get(id).history.length).toBe(history + 2);
      expect(b.channels.get(id).history.length).toBe(history + 2);
    });

    it('refuses a proposal that lowers the receiver, and one built on an older state', async () => {
      const r = a.channels.get(id);
      const key = channelSecrets(await alice.keys.poolKeys(), r.index).signingKey;
      const s = r.latest.state;
      const message = (state: typeof s, prev: typeof s) => ({
        type: 'pay',
        channelId: id,
        prevHash: hashOf(r, prev),
        state,
        sig: signStateHash(key, hashOf(r, state)),
        prevSig: signStateHash(key, hashOf(r, prev)),
      });
      const steal = { ...s, balA: s.balA + 1n, balB: s.balB - 1n, nonce: s.nonce + 1n };
      expect(await code(b.channels.handle(a.p2p.peerId, message(steal, s)))).toBe('PROPOSAL_REFUSED');
      const fromOld = { ...r.state0.state, nonce: s.nonce + 1n };
      expect(await code(b.channels.handle(a.p2p.peerId, message(fromOld, r.state0.state)))).toBe('STALE_STATE');
      expect(await code(b.channels.handle(c.p2p.peerId, message(steal, s)))).toBe('CHANNEL_NOT_FOUND');
      sameLatest(id);
    });

    it('keeps a payment the locked receiver did not sign and sends it first once it is back', async () => {
      const before = sameLatest(id);
      bob.wallet.lock();
      expect(await code(a.channels.pay(id, 500n))).toBe('WALLET_LOCKED');
      expect(a.channels.get(id).pending).not.toBeNull();
      await bob.wallet.unlock('password123');
      await a.channels.pay(id, 700n);
      const after = sameLatest(id);
      expect(after.balB - before.balB).toBe(1200n);
      expect(a.channels.get(id).pending).toBeNull();
    });

    it('closes cooperatively with one ordinary transfer that pays both sides and the relayer', async () => {
      const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
      await relayer.user.pool.sync();
      const relayerBefore = shielded(relayer.user);
      const closed = await a.channels.close(id, relayer.port);
      expect(closed.status).toBe('closed');
      expect(closed.latest.state.final).toBe(true);
      expect(await b.channels.tick(relayer.port)).toEqual([]);
      expect(b.channels.get(id).status).toBe('closed');
      const s = closed.latest.state;
      expect(shielded(alice)).toBe(aliceBefore + s.balA);
      expect(shielded(bob)).toBe(bobBefore + s.balB);
      await relayer.user.pool.sync();
      expect(shielded(relayer.user)).toBe(relayerBefore + s.closingFee);
      expect(await code(a.channels.pay(id, 1n))).toBe('NOT_LIVE');
    });
  });

  it('refuses to open with an out-of-range window, or when the invitee would fund without approving', async () => {
    expect(await code(a.channels.open(await invite(bob, b), { token: ETH, amount: parseEther('0.01'), window: 8n * 86_400n, relayer: relayer.port }))).toBe('INVALID_WINDOW');
    expect(await code(a.channels.open(await invite(carol, c), { token: ETH, amount: parseEther('0.01'), peerAmount: 1n, relayer: relayer.port }))).toBe('OPEN_DECLINED');
  });

  describe('disputes (BRD 2.2.10)', () => {
    it('A: the invitee never funds; the opener disputes with state 0 and recovers its contribution', async () => {
      const window = 10n;
      const opened = await a.channels.open(await invite(bob, b), { token: ETH, amount: parseEther('0.02'), peerAmount: parseEther('0.01'), window, relayer: relayer.port });
      // Bob never ticks, so he never funds. State 1 lists his missing contribution, so only state 0 can be proven.
      expect(opened.status).toBe('funding');
      const before = shielded(alice);
      await a.disputes.start(opened.id, relayer.port);
      expect(a.channels.get(opened.id).status).toBe('disputing');
      expect(await a.disputes.tick(relayer.port)).toEqual([]); // deadline not reached: nothing to do
      expect(a.channels.get(opened.id).status).toBe('disputing');
      await passDeadline(window);
      expect(await a.disputes.tick(relayer.port)).toEqual([]);
      expect(a.channels.get(opened.id).status).toBe('settled');
      expect(shielded(alice)).toBe(before + parseEther('0.02') - fees.eth);
      // Bob's record is cleaned up too: nothing of his was in the channel.
      expect(await b.disputes.tick(relayer.port)).toEqual([]);
      expect(b.channels.get(opened.id).status).toBe('settled');
    });

    it('B: a cheater submits an old state; the other side answers with the latest, which is what settles', async () => {
      const window = 25n;
      const id = await openLive(window);
      await a.channels.pay(id, parseEther('0.04'));
      const latest = sameLatest(id);
      const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
      // Alice's app "forgets" every payment and disputes with state 0 (all of her contribution back to her).
      await a.channels.update(id, async (r) => {
        r.latest = { ...r.state0 };
      });
      await a.disputes.start(id, relayer.port);
      expect(await b.disputes.tick(relayer.port)).toEqual([]); // Bob notices and submits the latest state
      expect(b.channels.get(id).status).toBe('disputing');
      await passDeadline(window);
      expect(await a.disputes.tick(relayer.port)).toEqual([]); // Alice cannot finalize Bob's state, nor needs to
      expect(await b.disputes.tick(relayer.port)).toEqual([]); // Bob finalizes and takes his payout
      expect(b.channels.get(id).status).toBe('settled');
      expect(await a.disputes.tick(relayer.port)).toEqual([]);
      expect(a.channels.get(id).status).toBe('settled');
      expect(shielded(alice)).toBe(aliceBefore + latest.balA);
      expect(shielded(bob)).toBe(bobBefore + latest.balB);
    });

    it('C: the other side misses the window; state 0 settles and the left-out contribution is reclaimed', async () => {
      const window = 10n;
      const id = await openLive(window, parseEther('0.03'), parseEther('0.02'));
      await a.channels.pay(id, parseEther('0.01'));
      const [aliceBefore, bobBefore] = [shielded(alice), shielded(bob)];
      await a.channels.update(id, async (r) => {
        r.latest = { ...r.state0 };
      });
      await a.disputes.start(id, relayer.port);
      await passDeadline(window); // Bob is away the whole window
      expect(await a.disputes.tick(relayer.port)).toEqual([]);
      expect(a.channels.get(id).status).toBe('settled');
      expect(shielded(alice)).toBe(aliceBefore + parseEther('0.03') - fees.eth);
      // Bob comes back: his payout in state 0 is nothing, and his contribution is reclaimed minus the relayer fee.
      expect(await b.disputes.tick(relayer.port)).toEqual([]);
      expect(b.channels.get(id).status).toBe('settled');
      expect(shielded(bob)).toBe(bobBefore + parseEther('0.02') - fees.eth);
      // He was owed 0.03 by the latest state: missing the window cost him the 0.01 Alice had paid (BRD scenario C).
      expect(mine(b.channels.get(id))).toBe(parseEther('0.03'));
    });
  });
});
