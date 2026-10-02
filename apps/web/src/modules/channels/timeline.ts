import { balanceOf, sideOf, signedStates, type ChannelRecord } from '@occulta/framework';

type State = ReturnType<typeof signedStates>[number];
type Side = 0 | 1;

export type TimelineEntry =
  | { kind: 'event'; text: string }
  | { kind: 'payment'; outgoing: boolean; amount: bigint; pending?: boolean }
  | { kind: 'final'; mine: bigint; theirs: bigint };

export interface TimelineInput {
  me: Side;
  opener: 'me' | 'them';
  myContribution: bigint;
  theirContribution: bigint;
  /** Every state signed by both sides, oldest first. */
  states: readonly State[];
  /** This side's proposal still waiting for the other side's signature. */
  pending: State | null;
  latest: State;
  status: ChannelRecord['status'];
}

/** The channel's history as a conversation: contributions, payments either way, and how it ended. */
export function entriesFrom(t: TimelineInput): TimelineEntry[] {
  const out: TimelineEntry[] = [{ kind: 'event', text: t.opener === 'me' ? 'You opened this channel' : 'They opened this channel' }];
  for (let i = 1; i < t.states.length; i++) {
    const prev = t.states[i - 1] as State;
    const cur = t.states[i] as State;
    // State 1 only adds the second contribution; it moves nothing between the two sides.
    if (prev.contribs[1] === 0n && cur.contribs[1] !== 0n) continue;
    if (cur.final) {
      out.push({ kind: 'final', mine: balanceOf(cur, t.me), theirs: balanceOf(cur, t.me === 0 ? 1 : 0) });
      continue;
    }
    const delta = balanceOf(cur, t.me) - balanceOf(prev, t.me);
    if (delta > 0n) out.push({ kind: 'payment', outgoing: false, amount: delta });
    else if (delta < 0n) out.push({ kind: 'payment', outgoing: true, amount: -delta });
  }
  if (t.pending && !t.pending.final) {
    const delta = balanceOf(t.latest, t.me) - balanceOf(t.pending, t.me);
    if (delta > 0n) out.push({ kind: 'payment', outgoing: true, amount: delta, pending: true });
  }
  if (t.status === 'opening' || t.status === 'funding') out.push({ kind: 'event', text: 'Waiting for the contributions to reach the pool' });
  if (t.status === 'disputing') out.push({ kind: 'event', text: 'Dispute in progress' });
  if (t.status === 'closed') out.push({ kind: 'event', text: 'Closed · your share is in your shielded balance' });
  if (t.status === 'settled') out.push({ kind: 'event', text: 'Settled on-chain' });
  return out;
}

export function timelineOf(r: ChannelRecord): TimelineEntry[] {
  const me = sideOf(r);
  const a = r.contribA.amount;
  const b = r.contribB?.amount ?? 0n;
  return entriesFrom({
    me,
    opener: r.role === 'A' ? 'me' : 'them',
    myContribution: me === 0 ? a : b,
    theirContribution: me === 0 ? b : a,
    states: signedStates(r),
    pending: r.pending?.state ?? null,
    latest: r.latest.state,
    status: r.status,
  });
}
