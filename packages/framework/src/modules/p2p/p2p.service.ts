import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { lpStream } from '@libp2p/utils';
import { multiaddr } from '@multiformats/multiaddr';
import { AppError, isAppError } from '../../shared/errors/AppError.ts';
import type { Invite } from './invite.ts';

export const CHANNEL_PROTOCOL = '/occulta/channel/1.0.0';
const TIMEOUT_MS = 60_000;

/** Handles one request from a peer and returns the response (throwing an AppError refuses it). */
export type RequestHandler = (fromPeerId: string, message: unknown) => Promise<unknown>;

export interface PeerTarget {
  peerId: string;
  addrs: string[];
}

type Envelope = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** JSON with bigints as decimal strings (field elements, amounts and nonces travel this way). */
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

/**
 * Encrypted peer-to-peer messaging over libp2p (BRD 2.2.6). Peers are found through private
 * invites and reached through relays; channel messages travel only over these connections.
 * One request and one response per stream.
 */
export class P2PService {
  readonly node: Libp2p;
  private handler: RequestHandler | null = null;

  constructor(node: Libp2p) {
    this.node = node;
  }

  get peerId(): string {
    return this.node.peerId.toString();
  }

  async listen(handler: RequestHandler): Promise<void> {
    this.handler = handler;
    await this.node.handle(CHANNEL_PROTOCOL, (stream, connection) => this.serve(stream, connection), { runOnLimitedConnection: true });
  }

  /** Addresses that reach this node through a relay, for invites (never a direct IP address). */
  relayAddresses(): string[] {
    return this.node
      .getMultiaddrs()
      .map((a) => a.toString())
      .filter((a) => a.includes('/p2p-circuit'));
  }

  /** Waits until the node holds a relay reservation, so it is reachable through an invite. */
  async waitForRelay(timeoutMs = 30_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const addrs = this.relayAddresses();
      if (addrs.length > 0) return addrs;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new AppError(503, 'NO_RELAY', 'No libp2p relay is reachable; add one in the network settings');
  }

  invite(shieldedAddress: string): Invite {
    return { v: 1, peerId: this.peerId, addrs: this.relayAddresses(), shieldedAddress };
  }

  async request(peer: PeerTarget, message: unknown): Promise<unknown> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let stream: Stream;
    try {
      stream = await this.node.dialProtocol(peer.addrs.map((a) => multiaddr(a)), CHANNEL_PROTOCOL, { runOnLimitedConnection: true, signal });
    } catch {
      throw new AppError(503, 'PEER_UNREACHABLE', 'The other party is not reachable right now');
    }
    const lp = lpStream(stream);
    await lp.write(encode(message), { signal });
    const reply = decode((await lp.read({ signal })).subarray()) as Envelope;
    await stream.close().catch(() => undefined);
    if (!reply.ok) throw new AppError(409, reply.code, reply.message);
    return reply.result;
  }

  async stop(): Promise<void> {
    await this.node.stop();
  }

  private async serve(stream: Stream, connection: Connection): Promise<void> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const lp = lpStream(stream);
    let reply: Envelope;
    try {
      const message = decode((await lp.read({ signal })).subarray());
      if (!this.handler) throw new AppError(503, 'NOT_LISTENING', 'This node does not accept channel messages');
      reply = { ok: true, result: await this.handler(connection.remotePeer.toString(), message) };
    } catch (err) {
      reply = isAppError(err) ? { ok: false, code: err.code, message: err.message } : { ok: false, code: 'INTERNAL', message: 'The other party could not handle the message' };
    }
    await lp.write(encode(reply), { signal }).catch(() => undefined);
    await stream.close().catch(() => undefined);
  }
}
