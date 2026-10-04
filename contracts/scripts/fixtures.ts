// Generates real Groth16 proofs for scripted scenarios that the contracts' native tests replay.
// Deposits are mirrored with the same commitments the pool computes, so every proof is built
// against the root the contract will have. Output: circuits/build/fixtures/{pool,dispute}.json
// (regenerated after every circuit setup, because proofs depend on the proving keys).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { bytesToHex, concatHex, type Address, type Hex } from 'viem';
import {
  MerkleTree,
  channelPublicKeyOf,
  channelTagOf,
  dummyInput,
  extDataHashOf,
  finalizeWitness,
  noteCommitment,
  noteInner,
  ownerTagOf,
  paramsHashOf,
  payoutSaltOf,
  reclaimWitness,
  signStateHash,
  stateHashOf,
  submitStateWitness,
  toEvmProof,
  transferWitness,
  type ChannelParams,
  type ChannelState,
  type CircuitInput,
  type NotePreimage,
  type SignedState,
  type SpendInput,
} from '@occulta/framework/protocol';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = join(repo, 'packages/framework/artifacts');
const out = join(repo, 'circuits/build/fixtures');

const ETH = 0n;
const RECIPIENT: Address = '0x1111111111111111111111111111111111111111';
const DAY = 86_400n;
const str = (v: bigint): string => v.toString();

/** Distinct, recognisable 168-byte ciphertexts; the contracts only hash them. */
const ciphertext = (tag: number): Hex => bytesToHex(new Uint8Array(168).fill(tag));
const ciphertexts = (base: number): [Hex, Hex, Hex] => [ciphertext(base), ciphertext(base + 1), ciphertext(base + 2)];

async function prove(name: string, input: CircuitInput, expected: bigint[]) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, join(artifacts, `${name}.wasm`), join(artifacts, `${name}.zkey`));
  if (publicSignals.join() !== expected.map(String).join()) throw new Error(`${name}: unexpected public signals`);
  return { proof: toEvmProof(proof).map(str), signals: publicSignals };
}

class Pool {
  readonly tree = new MerkleTree();
  readonly deposits: { token: Address; amount: string; inner: string; commitment: string; ciphertext: Hex }[] = [];

  deposit(note: NotePreimage, tag: number): void {
    const commitment = noteCommitment(note);
    this.tree.insert(commitment);
    this.deposits.push({
      token: '0x0000000000000000000000000000000000000000',
      amount: str(note.amount),
      inner: str(noteInner(note.ownerTag, note.salt)),
      commitment: str(commitment),
      ciphertext: ciphertext(tag),
    });
  }

  spend(note: NotePreimage, unlock: SpendInput['unlock']): SpendInput {
    return { note, unlock, proof: this.tree.proof(this.tree.indexOf(noteCommitment(note))) };
  }

  insertOutputs(commitments: readonly bigint[]): void {
    for (const c of commitments) this.tree.insert(c);
  }
}

async function poolScenario() {
  const pool = new Pool();
  const alice = 1001n;
  const bob = 1002n;
  const relayer = ownerTagOf(1003n);
  const noteA: NotePreimage = { amount: 100n, token: ETH, ownerTag: ownerTagOf(alice), salt: 11n };
  pool.deposit(noteA, 1);

  // 1. Alice pays Bob 30 privately: outputs Bob 30, change 69, relayer fee 1.
  const bobNote: NotePreimage = { amount: 30n, token: ETH, ownerTag: ownerTagOf(bob), salt: 12n };
  const transferCts = ciphertexts(10);
  const t1 = transferWitness({
    root: pool.tree.root,
    token: ETH,
    inputs: [pool.spend(noteA, { kind: 'personal', secret: alice }), dummyInput(ETH)],
    outputs: [bobNote, { amount: 69n, token: ETH, ownerTag: ownerTagOf(alice), salt: 13n }, { amount: 1n, token: ETH, ownerTag: relayer, salt: 14n }],
    publicAmount: 0n,
    extDataHash: extDataHashOf({ recipient: '0x0000000000000000000000000000000000000000', ciphertexts: transferCts }),
  });
  const transfer = { ...(await prove('transfer', t1.input, t1.publicSignals)), recipient: '0x0000000000000000000000000000000000000000', ciphertexts: concatHex(transferCts) };
  pool.insertOutputs(t1.commitments);

  // 2. Bob withdraws 20 to a fresh address: change 9, an empty output, relayer fee 1.
  const withdrawCts = ciphertexts(20);
  const t2 = transferWitness({
    root: pool.tree.root,
    token: ETH,
    inputs: [pool.spend(bobNote, { kind: 'personal', secret: bob }), dummyInput(ETH)],
    outputs: [{ amount: 9n, token: ETH, ownerTag: ownerTagOf(bob), salt: 15n }, { amount: 0n, token: ETH, ownerTag: ownerTagOf(bob), salt: 16n }, { amount: 1n, token: ETH, ownerTag: relayer, salt: 17n }],
    publicAmount: 20n,
    extDataHash: extDataHashOf({ recipient: RECIPIENT, ciphertexts: withdrawCts }),
  });
  const withdrawal = { ...(await prove('transfer', t2.input, t2.publicSignals)), recipient: RECIPIENT, ciphertexts: concatHex(withdrawCts) };
  pool.insertOutputs(t2.commitments);

  return { deposits: pool.deposits, transfer, withdrawal, finalRoot: str(pool.tree.root) };
}

class Channel {
  readonly keyA = new Uint8Array(32).fill(41);
  readonly keyB = new Uint8Array(32).fill(42);
  readonly aliceRefund: bigint;
  readonly bobRefund: bigint;
  readonly params: ChannelParams;
  readonly paramsHash: bigint;

  constructor(channelSecret: bigint, refundBase: bigint) {
    this.aliceRefund = refundBase;
    this.bobRefund = refundBase + 1n;
    this.params = { pkA: channelPublicKeyOf(this.keyA), pkB: channelPublicKeyOf(this.keyB), channelSecret, window: 3n * DAY };
    this.paramsHash = paramsHashOf(this.params);
  }

  contribution(amount: bigint, side: 'A' | 'B', salt: bigint): NotePreimage {
    const refund = side === 'A' ? this.aliceRefund : this.bobRefund;
    return { amount, token: ETH, ownerTag: channelTagOf(this.paramsHash, ownerTagOf(refund)), salt };
  }

  sign(fields: Omit<ChannelState, 'payoutA' | 'payoutB' | 'final'>): SignedState {
    const state: ChannelState = { ...fields, payoutA: ownerTagOf(this.aliceRefund), payoutB: ownerTagOf(this.bobRefund), final: false };
    const h = stateHashOf(this.paramsHash, state);
    return { params: this.params, state, sigA: signStateHash(this.keyA, h), sigB: signStateHash(this.keyB, h) };
  }

  closeOutputs(signed: SignedState, relayerTag: bigint): [NotePreimage, NotePreimage, NotePreimage] {
    const h = stateHashOf(this.paramsHash, signed.state);
    const s = signed.state;
    return [
      { amount: s.balA, token: ETH, ownerTag: s.payoutA, salt: payoutSaltOf(this.params.channelSecret, h, 0) },
      { amount: s.balB, token: ETH, ownerTag: s.payoutB, salt: payoutSaltOf(this.params.channelSecret, h, 1) },
      { amount: s.closingFee, token: ETH, ownerTag: relayerTag, salt: 99n },
    ];
  }
}

async function submit(pool: Pool, signed: SignedState) {
  const proofs = signed.state.contribs.map((c) => (c === 0n ? pool.tree.emptyProof() : pool.tree.proof(pool.tree.indexOf(c))));
  const w = submitStateWitness({ root: pool.tree.root, channel: signed, contribProofs: [proofs[0], proofs[1]] as never });
  return prove('submit_state', w.input, w.publicSignals);
}

async function disputeScenario() {
  const pool = new Pool();
  const relayer = ownerTagOf(1003n);

  // Channel 1: both funded; Alice disputes with an old state, Bob answers with the latest, it finalizes.
  const ch = new Channel(777n, 2001n);
  const cA = ch.contribution(60n, 'A', 21n);
  const cB = ch.contribution(40n, 'B', 22n);
  pool.deposit(cA, 30);
  pool.deposit(cB, 31);
  const contribs = [noteCommitment(cA), noteCommitment(cB)] as const;
  const old = ch.sign({ contribs, balA: 60n, balB: 40n, closingFee: 0n, nonce: 100n });
  const latest = ch.sign({ contribs, balA: 45n, balB: 54n, closingFee: 1n, nonce: 200n });
  const submitOld = await submit(pool, old);
  const submitLatest = await submit(pool, latest);
  const finalCts = ciphertexts(40);
  const fw = finalizeWitness({
    root: pool.tree.root,
    token: ETH,
    inputs: [pool.spend(cA, { kind: 'channel', refundTag: ownerTagOf(ch.aliceRefund) }), pool.spend(cB, { kind: 'channel', refundTag: ownerTagOf(ch.bobRefund) })],
    outputs: ch.closeOutputs(latest, relayer),
    extDataHash: extDataHashOf({ recipient: '0x0000000000000000000000000000000000000000', ciphertexts: finalCts }),
    channel: latest,
  });
  const finalize = { ...(await prove('finalize', fw.input, fw.publicSignals)), ciphertexts: concatHex(finalCts) };
  pool.insertOutputs(fw.commitments);

  // Channel 2 (scenario C): state 0 lists only Alice's contribution; after it finalizes, Bob reclaims his.
  const ch2 = new Channel(888n, 3001n);
  const c2A = ch2.contribution(60n, 'A', 23n);
  const c2B = ch2.contribution(40n, 'B', 24n);
  pool.deposit(c2A, 50);
  pool.deposit(c2B, 51);
  const state0 = ch2.sign({ contribs: [noteCommitment(c2A), 0n], balA: 59n, balB: 0n, closingFee: 1n, nonce: 5n });
  const submitState0 = await submit(pool, state0);
  const f2Cts = ciphertexts(60);
  const f2 = finalizeWitness({
    root: pool.tree.root,
    token: ETH,
    inputs: [pool.spend(c2A, { kind: 'channel', refundTag: ownerTagOf(ch2.aliceRefund) }), dummyInput(ETH)],
    outputs: ch2.closeOutputs(state0, relayer),
    extDataHash: extDataHashOf({ recipient: '0x0000000000000000000000000000000000000000', ciphertexts: f2Cts }),
    channel: state0,
  });
  const finalizeState0 = { ...(await prove('finalize', f2.input, f2.publicSignals)), ciphertexts: concatHex(f2Cts) };
  pool.insertOutputs(f2.commitments);
  const reclaimCts = ciphertexts(70);
  const rw = reclaimWitness({
    root: pool.tree.root,
    token: ETH,
    contribution: { note: c2B, proof: pool.tree.proof(pool.tree.indexOf(noteCommitment(c2B))) },
    refundSecret: ch2.bobRefund,
    extra: dummyInput(ETH),
    params: ch2.params,
    outputs: [
      { amount: 39n, token: ETH, ownerTag: ownerTagOf(ch2.bobRefund), salt: 25n },
      { amount: 0n, token: ETH, ownerTag: ownerTagOf(ch2.bobRefund), salt: 26n },
      { amount: 1n, token: ETH, ownerTag: relayer, salt: 27n },
    ],
    extDataHash: extDataHashOf({ recipient: '0x0000000000000000000000000000000000000000', ciphertexts: reclaimCts }),
  });
  const reclaim = { ...(await prove('reclaim', rw.input, rw.publicSignals)), ciphertexts: concatHex(reclaimCts) };

  return { deposits: pool.deposits, window: str(3n * DAY), submitOld, submitLatest, finalize, submitState0, finalizeState0, reclaim };
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'pool.json'), JSON.stringify(await poolScenario(), null, 2));
writeFileSync(join(out, 'dispute.json'), JSON.stringify(await disputeScenario(), null, 2));
console.log(`fixtures written to ${out}`);
process.exit(0);
