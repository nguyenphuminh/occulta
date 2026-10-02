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

export const peerName = (r: ChannelRecord) => `Peer ${r.peer.peerId.slice(-6)}`;
