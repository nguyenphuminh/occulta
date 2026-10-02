import { bytesToHex, hexToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  channelPublicKeyOf,
  decryptNote,
  encryptionPublicKeyOf,
  generateChannelKey,
  noteCommitment,
  payoutSaltOf,
  randomFieldElement,
  type ChannelState,
} from '../../shared/protocol/index.ts';
import type { ChannelRecord } from './channel.schema.ts';
import {
  MAX_NONCE,
  contributionCommitments,
  hashOf,
  historyEntry,
  holdsState,
  nonceStep,
  openingState,
  payoutNote,
  settlement,
  signedStates,
  successorProblem,
  winsTieBreak,
} from './channel.state.ts';

const sig = { R8x: 1n, R8y: 2n, S: 3n };
const encA = crypto.getRandomValues(new Uint8Array(32));
const encB = crypto.getRandomValues(new Uint8Array(32));
const feeKey = crypto.getRandomValues(new Uint8Array(32));

/** A channel with A funding 100, B funding 50, a closing fee of 2, and state 1 as the latest. */
function channel(): ChannelRecord {
  const base = {
    id: 'c',
    role: 'A' as const,
    index: 0,
    peer: { peerId: 'p', addrs: [] },
    token: 0n,
    status: 'live' as const,
    params: { pkA: channelPublicKeyOf(generateChannelKey()), pkB: channelPublicKeyOf(generateChannelKey()), channelSecret: randomFieldElement(), window: 600n },
    encPubA: bytesToHex(encryptionPublicKeyOf(encA)),
    encPubB: bytesToHex(encryptionPublicKeyOf(encB)),
    contribA: { amount: 100n, salt: randomFieldElement() },
    contribB: { amount: 50n, salt: randomFieldElement() },
    pending: null,
    history: [],
    closeTx: null,
  };
  const tags = { tagA: randomFieldElement(), tagB: randomFieldElement() };
  const s0 = openingState({ ...tags, contribs: [0n, 0n], amountA: 100n, amountB: 0n, closingFee: 2n, nonce: 5n });
  const r: ChannelRecord = { ...base, state0: { state: s0, sigA: sig, sigB: sig }, latest: { state: s0, sigA: sig, sigB: sig } };
  const [cA, cB] = contributionCommitments(r);
  r.state0.state = { ...s0, contribs: [cA, 0n] };
  const s1 = openingState({ ...tags, contribs: [cA, cB], amountA: 100n, amountB: 50n, closingFee: 2n, nonce: 9n });
  r.latest = { state: s1, sigA: sig, sigB: sig };
  r.history.push(historyEntry(s1));
  return r;
}

describe('channel state rules', () => {
  it('steps nonces randomly between 1 and 2^32', () => {
    const steps = Array.from({ length: 500 }, nonceStep);
    for (const s of steps) expect(s >= 1n && s <= 2n ** 32n).toBe(true);
    expect(new Set(steps).size).toBeGreaterThan(490);
  });

  it('accepts a payment that does not lower this side and refuses every other change', () => {
    const prev = channel().latest.state;
    const pay = (change: Partial<ChannelState>): ChannelState => ({ ...prev, balA: prev.balA + 10n, balB: prev.balB - 10n, nonce: prev.nonce + 1n, ...change });
    expect(successorProblem(prev, pay({}), 'pay', 0)).toBeNull();
    expect(successorProblem(prev, pay({}), 'pay', 1)).toMatch(/lowers/);
    expect(successorProblem(prev, pay({ nonce: prev.nonce }), 'pay', 0)).toMatch(/nonce/);
    expect(successorProblem(prev, pay({ nonce: MAX_NONCE + 1n }), 'pay', 0)).toMatch(/nonce/);
    expect(successorProblem(prev, pay({ balA: prev.balA + 11n }), 'pay', 0)).toMatch(/total/);
    expect(successorProblem(prev, pay({ closingFee: 1n, balA: prev.balA + 11n }), 'pay', 0)).toMatch(/closing fee/);
    expect(successorProblem(prev, pay({ final: true }), 'pay', 0)).toMatch(/final/);
    expect(successorProblem(prev, pay({ contribs: [prev.contribs[0], 0n] }), 'pay', 0)).toMatch(/contributions/);
    expect(successorProblem(prev, pay({ payoutB: 7n }), 'pay', 0)).toMatch(/payout/);
    expect(successorProblem({ ...prev, final: true }, pay({}), 'pay', 0)).toMatch(/closing/);
  });

  it('lets a closing proposal change the fee when its proposer absorbs it', () => {
    const prev = channel().latest.state;
    // B proposes the close with a fee of 5 instead of 2 and pays the difference from its balance.
    const close = { ...prev, closingFee: 5n, balB: prev.balB - 3n, nonce: prev.nonce + 7n, final: true };
    expect(successorProblem(prev, close, 'close', 0)).toBeNull();
    expect(successorProblem(prev, close, 'close', 1)).toMatch(/lowers/);
    expect(successorProblem(prev, { ...close, final: false }, 'close', 0)).toMatch(/final/);
  });

  it('breaks ties by the smaller public key, x first then y', () => {
    expect(winsTieBreak([1n, 9n], [2n, 0n])).toBe(true);
    expect(winsTieBreak([2n, 0n], [1n, 9n])).toBe(false);
    expect(winsTieBreak([3n, 1n], [3n, 2n])).toBe(true);
    expect(winsTieBreak([3n, 2n], [3n, 1n])).toBe(false);
  });

  it('rebuilds every signed state from the compact history and finds one by hash', () => {
    const r = channel();
    const s2 = { ...r.latest.state, balA: 90n, balB: 58n, nonce: 30n };
    r.history.push(historyEntry(s2));
    const states = signedStates(r);
    expect(states.map((s) => s.nonce)).toEqual([5n, 9n, 30n]);
    expect(states[0]?.contribs[1]).toBe(0n);
    expect(hashOf(r, states[2] as ChannelState)).toBe(hashOf(r, s2));
    expect(holdsState(r, hashOf(r, s2), 30n)).toBe(true);
    expect(holdsState(r, hashOf(r, r.latest.state), 9n)).toBe(true);
    expect(holdsState(r, hashOf(r, { ...s2, balA: 91n, balB: 57n }), 30n)).toBe(false);
  });

  it('builds the settlement of a state: payouts with state-fixed salts, the fee note, an input per listed contribution', () => {
    const r = channel();
    const proofOf = () => ({ leafIndex: 0, pathElements: [] });
    const feeTo = { ownerTag: 77n, encryptionPublicKey: encryptionPublicKeyOf(feeKey) };
    const full = settlement(r, r.latest.state, proofOf, feeTo);
    expect(full.outputs.map((o) => o.amount)).toEqual([98n, 50n, 2n]);
    expect(full.outputs[0].salt).toBe(payoutSaltOf(r.params.channelSecret, hashOf(r, r.latest.state), 0));
    expect(full.outputs[1]).toEqual(payoutNote(r, r.latest.state, 1));
    expect(full.inputs.map((i) => noteCommitment(i.note))).toEqual([...contributionCommitments(r)]);
    expect(decryptNote({ privateKey: encB, publicKey: encryptionPublicKeyOf(encB) }, hexToBytes(full.ciphertexts[1]))).toEqual(full.outputs[1]);
    expect(decryptNote({ privateKey: feeKey, publicKey: feeTo.encryptionPublicKey }, hexToBytes(full.ciphertexts[2]))).toEqual(full.outputs[2]);

    const onlyA = settlement(r, r.state0.state, proofOf, feeTo);
    expect(onlyA.outputs.map((o) => o.amount)).toEqual([98n, 0n, 2n]);
    expect(onlyA.inputs[1].note.amount).toBe(0n);
    expect(onlyA.inputs[1].unlock.kind).toBe('personal');
  });
});
