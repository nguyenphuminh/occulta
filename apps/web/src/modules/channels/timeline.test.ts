import { describe, expect, it } from 'vitest';
import { entriesFrom, type TimelineInput } from './timeline.ts';

const state = (balA: bigint, balB: bigint, nonce: bigint, contribB = 7n, final = false) => ({
  contribs: [5n, contribB] as const,
  balA,
  balB,
  payoutA: 1n,
  payoutB: 2n,
  closingFee: 1n,
  nonce,
  final,
});

const base: TimelineInput = {
  me: 0,
  opener: 'me',
  myContribution: 100n,
  theirContribution: 50n,
  states: [],
  pending: null,
  latest: state(99n, 50n, 2n),
  status: 'live',
};

describe('channel timeline', () => {
  it('shows payments from this side and the other, skipping the state that only adds a contribution', () => {
    const states = [state(99n, 0n, 1n, 0n), state(99n, 50n, 2n), state(89n, 60n, 5n), state(92n, 57n, 9n)];
    expect(entriesFrom({ ...base, states, latest: states[3]! })).toEqual([
      { kind: 'event', text: 'You opened this channel' },
      { kind: 'payment', outgoing: true, amount: 10n },
      { kind: 'payment', outgoing: false, amount: 3n },
    ]);
  });

  it('sees the same history from the other side', () => {
    const states = [state(99n, 0n, 1n, 0n), state(99n, 50n, 2n), state(89n, 60n, 5n)];
    expect(entriesFrom({ ...base, me: 1, opener: 'them', states, latest: states[2]! })).toEqual([
      { kind: 'event', text: 'They opened this channel' },
      { kind: 'payment', outgoing: false, amount: 10n },
    ]);
  });

  it('marks a payment still waiting for the other side, the final state and the channel status', () => {
    const states = [state(99n, 50n, 2n), state(89n, 60n, 5n, 7n, true)];
    expect(entriesFrom({ ...base, states, latest: states[1]!, status: 'closed' }).slice(1)).toEqual([
      { kind: 'final', mine: 89n, theirs: 60n },
      { kind: 'event', text: 'Closed · your share is in your shielded balance' },
    ]);
    const live = [state(99n, 50n, 2n)];
    expect(entriesFrom({ ...base, states: live, latest: live[0]!, pending: state(94n, 55n, 3n) }).at(-1)).toEqual({ kind: 'payment', outgoing: true, amount: 5n, pending: true });
    expect(entriesFrom({ ...base, states: live, latest: live[0]!, status: 'disputing' }).at(-1)).toEqual({ kind: 'event', text: 'Dispute in progress' });
  });
});
