import type { ChannelRecord } from '@occulta/framework';

export const STATUS_TEXT: Record<ChannelRecord['status'], string> = {
  opening: 'Opening',
  funding: 'Waiting for funding',
  live: 'Live',
  closing: 'Closing',
  closed: 'Closed',
  disputing: 'In dispute',
  settled: 'Settled',
};

/** The user's nickname for the peer, else a short form of its peer id. */
export const peerName = (peerId: string, names: Record<string, string>) => names[peerId] ?? `Peer ${peerId.slice(-6)}`;
