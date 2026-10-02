import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Libp2p } from '@libp2p/interface';
import { AppError } from '../../shared/errors/AppError.ts';
import { createPeerNode, createRelayNode } from '../../libp2p.node.ts';
import { decodeInvite, encodeInvite, inviteLink } from './invite.ts';
import { P2PService } from './p2p.service.ts';

describe('peer-to-peer messaging through a relay', () => {
  let relay: Libp2p;
  let alice: P2PService;
  let bob: P2PService;

  beforeAll(async () => {
    relay = await createRelayNode({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] });
    const relayAddr = relay.getMultiaddrs()[0]!.toString();
    alice = new P2PService(await createPeerNode({ relays: [relayAddr] }));
    bob = new P2PService(await createPeerNode({ relays: [relayAddr] }));
    await bob.listen(async (from, message) => {
      const m = message as { type: string; n?: number };
      if (m.type === 'refuse') throw new AppError(409, 'NOT_NOW', 'Bob says no');
      return { echo: m.n, from, big: 10n ** 30n };
    });
    await bob.waitForRelay();
    await alice.waitForRelay();
  }, 60_000);

  afterAll(async () => {
    await Promise.all([alice.stop(), bob.stop(), relay.stop()]);
  });

  it('invites contain only relay circuit addresses and round-trip through a link', () => {
    const invite = bob.invite('occ-test');
    expect(invite.addrs.length).toBeGreaterThan(0);
    for (const a of invite.addrs) expect(a).toContain('/p2p-circuit/p2p/');
    expect(decodeInvite(inviteLink('https://wallet.example', invite))).toEqual(invite);
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
    expect(() => decodeInvite('garbage')).toThrow(/not a valid Occulta invite/);
  });

  it('sends a request through the relay and gets the answer, with bigints as strings', async () => {
    const reply = await alice.request(bob.invite('x'), { type: 'hello', n: 7 });
    expect(reply).toEqual({ echo: 7, from: alice.peerId, big: (10n ** 30n).toString() });
  });

  it('passes refusals back as errors with their code', async () => {
    await expect(alice.request(bob.invite('x'), { type: 'refuse' })).rejects.toMatchObject({ code: 'NOT_NOW', message: 'Bob says no' });
  });

  it('keeps relayed connections through libp2p\u2019s connection health checks', async () => {
    // libp2p pings every connection every 10 s and drops connections that cannot answer.
    const target = bob.invite('x');
    await alice.request(target, { type: 'hello', n: 1 });
    await new Promise((r) => setTimeout(r, 12_000));
    expect(bob.relayAddresses().length).toBeGreaterThan(0);
    expect(alice.node.getConnections().length).toBeGreaterThan(0);
    expect(await alice.request(target, { type: 'hello', n: 2 })).toMatchObject({ echo: 2 });
  }, 30_000);

  it('reports an unreachable peer', async () => {
    const gone = { ...bob.invite('x'), addrs: [bob.invite('x').addrs[0]!.replace(bob.peerId, alice.peerId.replace(/.$/, 'X'))] };
    await expect(alice.request(gone, { type: 'hello' })).rejects.toMatchObject({ code: 'PEER_UNREACHABLE' });
  });
});
