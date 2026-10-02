// The deployed Stylus contracts on a local Nitro dev node, driven with real proofs: pool deposits,
// transfers and withdrawals in ETH and USDG, a cooperative channel close, and a full dispute.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hexToBytes, parseAbi, zeroAddress, type Address, type Hex, type WalletClient } from 'viem';
import {
  channelPublicKeyOf,
  channelTagOf,
  decryptNote,
  dummyInput,
  extDataHashOf,
  finalizeWitness,
  generateChannelKey,
  noteCommitment,
  noteInner,
  nullifierOf,
  ownerTagOf,
  paramsHashOf,
  payoutSaltOf,
  randomFieldElement,
  reclaimWitness,
  signStateHash,
  stateHashOf,
  submitStateWitness,
  transferWitness,
  type ChannelParams,
  type ChannelState,
  type MerkleTree,
  type NotePreimage,
  type SignedState,
  type SpendInput,
} from '../../packages/framework/src/shared/protocol/index.ts';
import { disputesAbi, erc20Abi, poolAbi } from '../../packages/framework/src/modules/chain/chain.abi.ts';
import { DEVNODE_DIR } from '../../scripts/lib/devnode.ts';
import type { Deployment } from '../../scripts/lib/stylus.ts';
import {
  ciphertextFor,
  client,
  encryptionKeys,
  freshAddress,
  freshDeployment,
  fundedAccount,
  mineBlock,
  mirrorTree,
  note,
  prove,
  revertName,
  send,
  tuple,
  type EncryptionKeys,
} from './chain.ts';

type Proof8 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
type Signals9 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

const ETH = 0n;
const WINDOW = 15n; // the dev-node contract build accepts windows from 10 seconds
const testTokenAbi = parseAbi(['function mint(address to, uint256 value)']);
const gas: Record<string, string> = {};

interface Party {
  wallet: WalletClient;
  secret: bigint;
  ownerTag: bigint;
  keys: EncryptionKeys;
}

async function party(eth = '1'): Promise<Party> {
  const secret = randomFieldElement();
  return { wallet: await fundedAccount(eth), secret, ownerTag: ownerTagOf(secret), keys: encryptionKeys() };
}

describe('Occulta contracts on a Nitro dev node', () => {
  let d: Deployment;
  let relayer: Party;
  let alice: Party;
  let bob: Party;
  let usdg: bigint;
  const start = { block: 0n };
  const tree = async (): Promise<MerkleTree> => mirrorTree(d.pool, start.block);
  const spend = (t: MerkleTree, n: NotePreimage, unlock: SpendInput['unlock']): SpendInput => ({
    note: n,
    unlock,
    proof: t.proof(t.indexOf(noteCommitment(n))),
  });

  async function deposit(p: Party, n: NotePreimage, label: string): Promise<void> {
    const token = n.token === ETH ? zeroAddress : d.usdg;
    if (n.token !== ETH) {
      await send(p.wallet, { address: d.usdg, abi: testTokenAbi, functionName: 'mint', args: [p.wallet.account!.address, n.amount] });
      await send(p.wallet, { address: d.usdg, abi: erc20Abi, functionName: 'approve', args: [d.pool, n.amount] });
    }
    const receipt = await send(p.wallet, {
      address: d.pool,
      abi: poolAbi,
      functionName: 'deposit',
      args: [token, n.amount, noteInner(n.ownerTag, n.salt), ciphertextFor(p.keys, n)],
      value: n.token === ETH ? n.amount : 0n,
    });
    gas[label] = receipt.gasUsed.toString();
  }

  /** Proves a transfer and submits it from the relayer's account. */
  async function transact(w: Parameters<typeof transferWitness>[0], recipient: Address, cts: [Hex, Hex, Hex], label: string) {
    const built = transferWitness({ ...w, extDataHash: extDataHashOf({ recipient, ciphertexts: cts }) });
    const { proof, signals } = await prove('transfer', built.input);
    const args = [tuple<Proof8>(proof), tuple<Signals9>(signals), recipient, `0x${cts.map((c) => c.slice(2)).join('')}` as Hex] as const;
    const receipt = await send(relayer.wallet, { address: d.pool, abi: poolAbi, functionName: 'transact', args });
    gas[label] = receipt.gasUsed.toString();
    return { built, args };
  }

  beforeAll(async () => {
    start.block = await client.getBlockNumber();
    d = await freshDeployment();
    usdg = BigInt(d.usdg);
    relayer = await party();
    alice = await party('2');
    bob = await party();
  });

  afterAll(() => {
    mkdirSync(DEVNODE_DIR, { recursive: true });
    writeFileSync(join(DEVNODE_DIR, 'gas-report.json'), JSON.stringify(gas, null, 2));
  });

  const aliceEth = note(10_000_000_000_000_000n, ETH, 0n); // 0.01 ETH, owner set below
  const aliceUsdg = note(100_000_000n, 0n, 0n); // 100 USDG (6 decimals)
  let bobEth: NotePreimage;

  it('computes each deposit commitment on-chain from what it received, in ETH and USDG', async () => {
    aliceEth.ownerTag = alice.ownerTag;
    Object.assign(aliceUsdg, { ownerTag: alice.ownerTag, token: usdg });
    await deposit(alice, aliceEth, 'deposit ETH');
    await deposit(alice, aliceUsdg, 'deposit USDG');
    const t = await tree();
    expect(t.leaves()).toEqual([noteCommitment(aliceEth), noteCommitment(aliceUsdg)]);
    expect(await client.readContract({ address: d.pool, abi: poolAbi, functionName: 'root' })).toBe(t.root);
    expect(await client.readContract({ address: d.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [d.pool] })).toBe(100_000_000n);
  });

  it('transfers privately through a relayer, and the payee finds the note by trial decryption', async () => {
    const t = await tree();
    bobEth = note(4_000_000_000_000_000n, ETH, bob.ownerTag);
    const outputs: [NotePreimage, NotePreimage, NotePreimage] = [bobEth, note(5_990_000_000_000_000n, ETH, alice.ownerTag), note(10_000_000_000_000n, ETH, relayer.ownerTag)];
    const { built } = await transact(
      { root: t.root, token: ETH, inputs: [spend(t, aliceEth, { kind: 'personal', secret: alice.secret }), dummyInput(ETH)], outputs, publicAmount: 0n, extDataHash: 0n },
      zeroAddress,
      [ciphertextFor(bob.keys, outputs[0]), ciphertextFor(alice.keys, outputs[1]), ciphertextFor(relayer.keys, outputs[2])],
      'private transfer',
    );
    for (const nf of built.nullifiers) expect(await client.readContract({ address: d.pool, abi: poolAbi, functionName: 'isSpent', args: [nf] })).toBe(true);

    const logs = await client.getContractEvents({ address: d.pool, abi: poolAbi, eventName: 'NewCommitment', fromBlock: start.block });
    const mine = logs.map((l) => decryptNote(bob.keys, hexToBytes(l.args.ciphertext!))).filter((n) => n !== null);
    expect(mine).toEqual([bobEth]);
  });

  it('withdraws ETH and USDG to fresh addresses, paying exactly the public amount', async () => {
    let t = await tree();
    const ethTo = freshAddress();
    const ethOut: [NotePreimage, NotePreimage, NotePreimage] = [note(990_000_000_000_000n, ETH, bob.ownerTag), note(0n, ETH, bob.ownerTag), note(10_000_000_000_000n, ETH, relayer.ownerTag)];
    await transact(
      { root: t.root, token: ETH, inputs: [spend(t, bobEth, { kind: 'personal', secret: bob.secret }), dummyInput(ETH)], outputs: ethOut, publicAmount: 3_000_000_000_000_000n, extDataHash: 0n },
      ethTo,
      [ciphertextFor(bob.keys, ethOut[0]), ciphertextFor(bob.keys, ethOut[1]), ciphertextFor(relayer.keys, ethOut[2])],
      'withdraw ETH',
    );
    expect(await client.getBalance({ address: ethTo })).toBe(3_000_000_000_000_000n);

    t = await tree();
    const usdgTo = freshAddress();
    const usdgOut: [NotePreimage, NotePreimage, NotePreimage] = [note(59_000_000n, usdg, alice.ownerTag), note(0n, usdg, alice.ownerTag), note(1_000_000n, usdg, relayer.ownerTag)];
    await transact(
      { root: t.root, token: usdg, inputs: [spend(t, aliceUsdg, { kind: 'personal', secret: alice.secret }), dummyInput(usdg)], outputs: usdgOut, publicAmount: 40_000_000n, extDataHash: 0n },
      usdgTo,
      [ciphertextFor(alice.keys, usdgOut[0]), ciphertextFor(alice.keys, usdgOut[1]), ciphertextFor(relayer.keys, usdgOut[2])],
      'withdraw USDG',
    );
    expect(await client.readContract({ address: d.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [usdgTo] })).toBe(40_000_000n);
    expect(await client.readContract({ address: d.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [d.pool] })).toBe(60_000_000n);
  });

  it('rejects a double spend, an unknown root, a changed recipient and a forged proof', async () => {
    const t = await tree();
    const n = note(1_000n, ETH, alice.ownerTag);
    await deposit(alice, n, 'deposit (small)');
    const t2 = await tree();
    void t;
    const outputs: [NotePreimage, NotePreimage, NotePreimage] = [note(500n, ETH, alice.ownerTag), note(500n, ETH, alice.ownerTag), note(0n, ETH, relayer.ownerTag)];
    const cts: [Hex, Hex, Hex] = [ciphertextFor(alice.keys, outputs[0]), ciphertextFor(alice.keys, outputs[1]), ciphertextFor(relayer.keys, outputs[2])];
    const { args } = await transact(
      { root: t2.root, token: ETH, inputs: [spend(t2, n, { kind: 'personal', secret: alice.secret }), dummyInput(ETH)], outputs, publicAmount: 0n, extDataHash: 0n },
      zeroAddress,
      cts,
      'private transfer (small)',
    );
    const simulate = (a: typeof args) => client.simulateContract({ account: relayer.wallet.account!, address: d.pool, abi: poolAbi, functionName: 'transact', args: a });
    expect(await revertName(simulate(args))).toBe('NullifierAlreadySpent');

    const [proof, signals, , cts2] = args;
    const fresh = [...signals];
    fresh[4] = randomFieldElement();
    fresh[5] = randomFieldElement();
    expect(await revertName(simulate([proof, tuple<Signals9>(fresh), freshAddress(), cts2]))).toBe('InvalidExtData');
    expect(await revertName(simulate([tuple<Proof8>([proof[0] + 1n, ...proof.slice(1)]), tuple<Signals9>(fresh), zeroAddress, cts2]))).toBe('InvalidProof');
    const unknownRoot = [...fresh];
    unknownRoot[0] = randomFieldElement();
    expect(await revertName(simulate([proof, tuple<Signals9>(unknownRoot), zeroAddress, cts2]))).toBe('UnknownRoot');
  });

  // --- channels ---

  class Channel {
    readonly keyA = generateChannelKey();
    readonly keyB = generateChannelKey();
    readonly aliceTag = randomFieldElement();
    readonly bobTag = randomFieldElement();
    readonly params: ChannelParams;
    readonly paramsHash: bigint;
    constructor(window: bigint) {
      this.params = { pkA: channelPublicKeyOf(this.keyA), pkB: channelPublicKeyOf(this.keyB), channelSecret: randomFieldElement(), window };
      this.paramsHash = paramsHashOf(this.params);
    }
    refundTag(side: 'A' | 'B'): bigint {
      return ownerTagOf(side === 'A' ? this.aliceTag : this.bobTag);
    }
    contribution(amount: bigint, side: 'A' | 'B'): NotePreimage {
      return note(amount, ETH, channelTagOf(this.paramsHash, this.refundTag(side)));
    }
    sign(fields: Omit<ChannelState, 'payoutA' | 'payoutB'>): SignedState {
      const state: ChannelState = { ...fields, payoutA: this.refundTag('A'), payoutB: this.refundTag('B') };
      const h = stateHashOf(this.paramsHash, state);
      return { params: this.params, state, sigA: signStateHash(this.keyA, h), sigB: signStateHash(this.keyB, h) };
    }
    payouts(signed: SignedState): [NotePreimage, NotePreimage, NotePreimage] {
      const h = stateHashOf(this.paramsHash, signed.state);
      const s = signed.state;
      return [
        { amount: s.balA, token: ETH, ownerTag: s.payoutA, salt: payoutSaltOf(this.params.channelSecret, h, 0) },
        { amount: s.balB, token: ETH, ownerTag: s.payoutB, salt: payoutSaltOf(this.params.channelSecret, h, 1) },
        note(s.closingFee, ETH, relayer.ownerTag),
      ];
    }
  }

  it('funds and cooperatively closes a channel with ordinary-looking transfers', async () => {
    const ch = new Channel(WINDOW);
    const aliceNote = note(100_000n, ETH, alice.ownerTag);
    const bobNote = note(50_000n, ETH, bob.ownerTag);
    await deposit(alice, aliceNote, 'deposit (channel A)');
    await deposit(bob, bobNote, 'deposit (channel B)');

    // Funding: each party's personal note becomes its contribution, its change and a fee note.
    const cA = ch.contribution(60_000n, 'A');
    const cB = ch.contribution(40_000n, 'B');
    for (const [p, from, contribution, change] of [
      [alice, aliceNote, cA, 39_900n],
      [bob, bobNote, cB, 9_900n],
    ] as const) {
      const t = await tree();
      const outputs: [NotePreimage, NotePreimage, NotePreimage] = [contribution, note(change, ETH, p.ownerTag), note(100n, ETH, relayer.ownerTag)];
      await transact(
        { root: t.root, token: ETH, inputs: [spend(t, from, { kind: 'personal', secret: p.secret }), dummyInput(ETH)], outputs, publicAmount: 0n, extDataHash: 0n },
        zeroAddress,
        [ciphertextFor(p.keys, outputs[0]), ciphertextFor(p.keys, outputs[1]), ciphertextFor(relayer.keys, outputs[2])],
        'channel funding',
      );
    }

    const t = await tree();
    const final = ch.sign({ contribs: [noteCommitment(cA), noteCommitment(cB)], balA: 45_000n, balB: 54_000n, closingFee: 1_000n, nonce: 7_777_777n, final: true });
    const outputs = ch.payouts(final);
    await transact(
      {
        root: t.root,
        token: ETH,
        inputs: [spend(t, cA, { kind: 'channel', refundTag: ch.refundTag('A') }), spend(t, cB, { kind: 'channel', refundTag: ch.refundTag('B') })],
        outputs,
        publicAmount: 0n,
        extDataHash: 0n,
        channel: final,
      },
      zeroAddress,
      [ciphertextFor(alice.keys, outputs[0]), ciphertextFor(bob.keys, outputs[1]), ciphertextFor(relayer.keys, outputs[2])],
      'cooperative close',
    );
    // Both payouts exist, and each party can rebuild its own payout from the state alone.
    const after = await tree();
    expect(after.indexOf(noteCommitment(outputs[0]))).toBeGreaterThan(-1);
    expect(after.indexOf(noteCommitment(outputs[1]))).toBeGreaterThan(-1);
    for (const c of [cA, cB]) {
      expect(await client.readContract({ address: d.pool, abi: poolAbi, functionName: 'isSpent', args: [nullifierOf(ch.params.channelSecret, noteCommitment(c))] })).toBe(true);
    }
  });

  it('resolves disputes: an old state is answered, finalized after the window, and an unlisted contribution is reclaimed', async () => {
    // Channel 1: both contributions in the pool; Alice disputes with an old state, Bob answers.
    const ch1 = new Channel(WINDOW);
    const a1 = ch1.contribution(60_000n, 'A');
    const b1 = ch1.contribution(40_000n, 'B');
    // Channel 2 (scenario C): state 0 lists only Alice's contribution although Bob funded too.
    const ch2 = new Channel(WINDOW);
    const a2 = ch2.contribution(60_000n, 'A');
    const b2 = ch2.contribution(40_000n, 'B');
    for (const [p, n, label] of [[alice, a1, 'deposit (contribution)'], [bob, b1, 'deposit (contribution)'], [alice, a2, 'deposit (contribution)'], [bob, b2, 'deposit (contribution)']] as const) {
      await deposit(p, n, label);
    }
    const contribs1 = [noteCommitment(a1), noteCommitment(b1)] as const;
    const old = ch1.sign({ contribs: contribs1, balA: 60_000n, balB: 40_000n, closingFee: 0n, nonce: 100n, final: false });
    const latest = ch1.sign({ contribs: contribs1, balA: 45_000n, balB: 54_000n, closingFee: 1_000n, nonce: 4_000_000_200n, final: false });
    const state0 = ch2.sign({ contribs: [noteCommitment(a2), 0n], balA: 59_000n, balB: 0n, closingFee: 1_000n, nonce: 5n, final: false });

    const submit = async (signed: SignedState, label: string) => {
      const t = await tree();
      const proofs = signed.state.contribs.map((c) => (c === 0n ? t.emptyProof() : t.proof(t.indexOf(c))));
      const w = submitStateWitness({ root: t.root, channel: signed, contribProofs: [proofs[0]!, proofs[1]!] });
      const { proof, signals } = await prove('submit_state', w.input);
      const receipt = await send(relayer.wallet, {
        address: d.disputes,
        abi: disputesAbi,
        functionName: 'submitState',
        args: [tuple<Proof8>(proof), tuple<readonly [bigint, bigint, bigint, bigint, bigint]>(signals)],
      });
      gas[label] = receipt.gasUsed.toString();
      return w.channelNullifier;
    };
    const cn1 = await submit(old, 'submit state');
    const [, , , deadline1] = await client.readContract({ address: d.disputes, abi: disputesAbi, functionName: 'disputeOf', args: [cn1] });
    await submit(latest, 'answer with a newer state');
    const [pending, nonce, stateHash, deadlineAfter] = await client.readContract({ address: d.disputes, abi: disputesAbi, functionName: 'disputeOf', args: [cn1] });
    expect([pending, nonce, stateHash]).toEqual([true, latest.state.nonce, stateHashOf(ch1.paramsHash, latest.state)]);
    expect(deadlineAfter).toBe(deadline1);
    const cn2 = await submit(state0, 'submit state');

    const finalize = async (ch: Channel, signed: SignedState, inputs: [SpendInput, SpendInput], label: string) => {
      const t = await tree();
      const outputs = ch.payouts(signed);
      const cts: [Hex, Hex, Hex] = [ciphertextFor(alice.keys, outputs[0]), ciphertextFor(bob.keys, outputs[1]), ciphertextFor(relayer.keys, outputs[2])];
      const fresh = inputs.map((s) => (s.note.amount === 0n ? s : spend(t, s.note, s.unlock))) as [SpendInput, SpendInput];
      const w = finalizeWitness({ root: t.root, token: ETH, inputs: fresh, outputs, extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts: cts }), channel: signed });
      const { proof, signals } = await prove('finalize', w.input);
      const args = [tuple<Proof8>(proof), tuple<Signals9>(signals), `0x${cts.map((c) => c.slice(2)).join('')}` as Hex] as const;
      return { args, outputs, run: async () => (gas[label] = (await send(relayer.wallet, { address: d.disputes, abi: disputesAbi, functionName: 'finalize', args })).gasUsed.toString()) };
    };
    const t = await tree();
    const f1 = await finalize(ch1, latest, [spend(t, a1, { kind: 'channel', refundTag: ch1.refundTag('A') }), spend(t, b1, { kind: 'channel', refundTag: ch1.refundTag('B') })], 'finalize');
    expect(await revertName(client.simulateContract({ account: relayer.wallet.account!, address: d.disputes, abi: disputesAbi, functionName: 'finalize', args: f1.args }))).toBe(
      'DeadlineNotReached',
    );

    await new Promise((r) => setTimeout(r, Number(WINDOW + 2n) * 1000));
    await mineBlock();
    await f1.run();
    expect(await client.readContract({ address: d.disputes, abi: disputesAbi, functionName: 'isFinalized', args: [cn1] })).toBe(true);
    const settled = await tree();
    expect(settled.indexOf(noteCommitment(f1.outputs[0]))).toBeGreaterThan(-1);
    expect(settled.indexOf(noteCommitment(f1.outputs[1]))).toBeGreaterThan(-1);

    const f2 = await finalize(ch2, state0, [spend(settled, a2, { kind: 'channel', refundTag: ch2.refundTag('A') }), dummyInput(ETH)], 'finalize');
    await f2.run();
    expect(await client.readContract({ address: d.disputes, abi: disputesAbi, functionName: 'isFinalized', args: [cn2] })).toBe(true);

    // Bob reclaims his contribution, which state 0 left out.
    const t3 = await tree();
    const returned: [NotePreimage, NotePreimage, NotePreimage] = [note(39_000n, ETH, bob.ownerTag), note(0n, ETH, bob.ownerTag), note(1_000n, ETH, relayer.ownerTag)];
    const cts: [Hex, Hex, Hex] = [ciphertextFor(bob.keys, returned[0]), ciphertextFor(bob.keys, returned[1]), ciphertextFor(relayer.keys, returned[2])];
    const rw = reclaimWitness({
      root: t3.root,
      token: ETH,
      contribution: { note: b2, proof: t3.proof(t3.indexOf(noteCommitment(b2))) },
      refundSecret: ch2.bobTag,
      extra: dummyInput(ETH),
      params: ch2.params,
      outputs: returned,
      extDataHash: extDataHashOf({ recipient: zeroAddress, ciphertexts: cts }),
    });
    const { proof, signals } = await prove('reclaim', rw.input);
    const receipt = await send(relayer.wallet, {
      address: d.disputes,
      abi: disputesAbi,
      functionName: 'reclaim',
      args: [tuple<Proof8>(proof), tuple<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]>(signals), `0x${cts.map((c) => c.slice(2)).join('')}` as Hex],
    });
    gas['reclaim'] = receipt.gasUsed.toString();
    expect((await tree()).indexOf(noteCommitment(returned[0]))).toBeGreaterThan(-1);
  });
});
