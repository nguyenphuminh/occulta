import type { ChannelRecord } from '@occulta/framework';
import type { PendingOpen } from './pendingOpens.ts';

export const STATUS_TEXT: Record<ChannelRecord['status'], string> = {
  opening: 'Opening',
  funding: 'Waiting for funding',
  live: 'Live',
  closing: 'Closing',
  closed: 'Closed',
  disputing: 'In dispute',
  settled: 'Settled',
};

/** An open still waiting for the other side, or one that did not happen (BRD 2.2.14.8). */
export const PENDING_TEXT: Record<PendingOpen['state'], string> = {
  waiting: 'Pending',
  declined: 'Declined',
  failed: 'Not opened',
};

/** The user's nickname for the peer, else a short form of its peer id. */
export const peerName = (peerId: string, names: Record<string, string>) => names[peerId] ?? `Peer ${peerId.slice(-6)}`;
