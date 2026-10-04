import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as snarkjs from 'snarkjs';
import {
  CHANNEL_DOMAIN,
  CLOSE_DOMAIN,
  channelNullifierOf,
  dummyInput,
  finalizeWitness,
  reclaimWitness,
  submitStateWitness,
  type FinalizeWitnessInput,
  type MerkleProof,
  type ReclaimWitnessInput,
} from '@occulta/framework/protocol';
import { prove, publicSignalNames, satisfies, verificationKey } from './helpers.ts';
import { ETH, EXT, TestChannel, USDG, World, note, person } from './world.ts';

const relayer = person();

/** Alice 60 / Bob 40 in USDG, both funded; the disputed state splits 45 / 54 with a closing fee of 1. */
function fundedChannel() {
  const world = new World();
  const ch = new TestChannel();
  const cA = world.addContribution(ch.contributionNote(60n, USDG, 'A'), ch.alice.ownerTag);
  const cB = world.addContribution(ch.contributionNote(40n, USDG, 'B'), ch.bob.ownerTag);
  const contribs = [world.tree.leaves()[0] as bigint, world.tree.leaves()[1] as bigint] as const;
  return { world, ch, cA: world.refresh(cA), cB, contribs };
}

function finalizeCase(): FinalizeWitnessInput & { ch: TestChannel } {
  const { world, ch, cA, cB, contribs } = fundedChannel();
  const signed = ch.sign(ch.state({ contribs, balA: 45n, balB: 54n, closingFee: 1n, nonce: 77_000n }));
  return {
    ch,
    root: world.tree.root,
    token: USDG,
    inputs: [cA, cB],
    outputs: ch.closeOutputs(signed, USDG, relayer.ownerTag),
    extDataHash: EXT,
    channel: signed,
  };
}

describe('constants', () => {
  it('circuit domain constants equal the protocol ones', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/lib/constants.circom'), 'utf8');
    const value = (fn: string): bigint => BigInt((src.match(new RegExp(`${fn}\\(\\)\\s*\\{\\s*return\\s+(\\d+)`)) as RegExpMatchArray)[1] as string);
    expect(value('CHANNEL_DOMAIN')).toBe(CHANNEL_DOMAIN);
    expect(value('CLOSE_DOMAIN')).toBe(CLOSE_DOMAIN);
  });
});

describe('finalize circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('finalize')).toEqual([
      'root',
      'extDataHash',
      'inNullifier[0]',
      'inNullifier[1]',
      'outCommitment[0]',
      'outCommitment[1]',
      'outCommitment[2]',
      'channelNullifier',
      'stateHash',
    ]);
  });

  it('settles a non-final pending state', async () => {
    expect(await satisfies('finalize', finalizeWitness(finalizeCase()).input)).toBe(true);
  });

  it('settles state 0 when only Alice funded (scenario A)', async () => {
    const world = new World();
    const ch = new TestChannel();
    const cA = world.addContribution(ch.contributionNote(60n, ETH, 'A'), ch.alice.ownerTag);
    const signed = ch.sign(ch.state({ contribs: [world.tree.leaves()[0] as bigint, 0n], balA: 59n, balB: 0n, closingFee: 1n, nonce: 5n }));
    const w: FinalizeWitnessInput = {
      root: world.tree.root,
      token: ETH,
      inputs: [cA, dummyInput(ETH)],
      outputs: ch.closeOutputs(signed, ETH, relayer.ownerTag),
      extDataHash: EXT,
      channel: signed,
    };
    expect(await satisfies('finalize', finalizeWitness(w).input)).toBe(true);
  });

  it('rejects a state hash other than the pending one', async () => {
    const built = finalizeWitness(finalizeCase());
    built.input.stateHash = (built.input.stateHash as bigint) + 1n;
    expect(await satisfies('finalize', built.input)).toBe(false);
  });

  it('rejects a channel nullifier from another channel', async () => {
    const built = finalizeWitness(finalizeCase());
    built.input.channelNullifier = channelNullifierOf(12345n);
    expect(await satisfies('finalize', built.input)).toBe(false);
  });

  it('rejects outputs that do not follow the pending state', async () => {
    const c = finalizeCase();
    const [a, b, fee] = c.outputs;
    c.outputs = [{ ...a, amount: 55n }, { ...b, amount: 44n }, fee];
    expect(await satisfies('finalize', finalizeWitness(c).input)).toBe(false);
  });

  it('rejects settling with personal notes instead of the listed contributions', async () => {
    // Without this, a party could mark the channel finalized without paying it out, then reclaim.
    const c = finalizeCase();
    const mallory = person();
    const world = new World();
    const a = world.addPersonal(note(60n, USDG, mallory.ownerTag), mallory);
    const b = world.addPersonal(note(40n, USDG, mallory.ownerTag), mallory);
    c.root = world.tree.root;
    c.inputs = [world.refresh(a), world.refresh(b)];
    expect(await satisfies('finalize', finalizeWitness(c).input)).toBe(false);
  });

  it('rejects a state signed by a stranger', async () => {
    const c = finalizeCase();
    c.channel = c.ch.sign(c.channel.state, { a: new TestChannel().keyA });
    expect(await satisfies('finalize', finalizeWitness(c).input)).toBe(false);
  });
});

function reclaimCase(): ReclaimWitnessInput & { ch: TestChannel } {
  const { world, ch, cB } = fundedChannel();
  const bobPersonal = person();
  return {
    ch,
    root: world.tree.root,
    token: USDG,
    contribution: { note: cB.note, proof: cB.proof },
    refundSecret: ch.bob.secret,
    extra: dummyInput(USDG),
    params: ch.params,
    outputs: [note(39n, USDG, bobPersonal.ownerTag), note(0n, USDG, bobPersonal.ownerTag), note(1n, USDG, relayer.ownerTag)],
    extDataHash: EXT,
  };
}

describe('reclaim circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('reclaim')).toEqual([
      'root',
      'extDataHash',
      'inNullifier[0]',
      'inNullifier[1]',
      'outCommitment[0]',
      'outCommitment[1]',
      'outCommitment[2]',
      'channelNullifier',
    ]);
  });

  it('returns a contribution to the owner of its refund tag (scenario C)', async () => {
    expect(await satisfies('reclaim', reclaimWitness(reclaimCase()).input)).toBe(true);
  });

  it('rejects anyone without the refund secret, including the counterparty', async () => {
    const c = reclaimCase();
    expect(await satisfies('reclaim', reclaimWitness({ ...c, refundSecret: c.ch.alice.secret }).input)).toBe(false);
    expect(await satisfies('reclaim', reclaimWitness({ ...c, refundSecret: person().secret }).input)).toBe(false);
  });

  it('rejects a channel nullifier of another channel', async () => {
    const built = reclaimWitness(reclaimCase());
    built.input.channelNullifier = channelNullifierOf(999n);
    expect(await satisfies('reclaim', built.input)).toBe(false);
  });

  it('rejects taking more than the contribution', async () => {
    const c = reclaimCase();
    const [a, b, fee] = c.outputs;
    c.outputs = [{ ...a, amount: 40n }, b, fee];
    expect(await satisfies('reclaim', reclaimWitness(c).input)).toBe(false);
  });
});

function submitCase(listBoth = true) {
  const { world, ch, contribs } = fundedChannel();
  const state = listBoth
    ? ch.state({ contribs, balA: 45n, balB: 54n, closingFee: 1n, nonce: 4_000_000_123n })
    : ch.state({ contribs: [contribs[0], 0n], balA: 59n, balB: 0n, closingFee: 1n, nonce: 7n });
  const proofs = [world.tree.proof(0), listBoth ? world.tree.proof(1) : world.tree.emptyProof()] as [MerkleProof, MerkleProof];
  return { world, ch, signed: ch.sign(state), proofs };
}

describe('submit-state circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('submit_state')).toEqual(['root', 'channelNullifier', 'nonce', 'stateHash', 'window']);
  });

  it('accepts a signed state whose listed contributions are all in the pool', async () => {
    for (const listBoth of [true, false]) {
      const c = submitCase(listBoth);
      expect(await satisfies('submit_state', submitStateWitness({ root: c.world.tree.root, channel: c.signed, contribProofs: c.proofs }).input)).toBe(true);
    }
  });

  it('rejects a state listing a contribution that was never funded', async () => {
    // Bob signed state 1 listing his contribution, then never funded: that state must not replace state 0.
    const world = new World();
    const ch = new TestChannel();
    world.addContribution(ch.contributionNote(60n, USDG, 'A'), ch.alice.ownerTag);
    const neverFunded = 123456789n;
    const signed = ch.sign(ch.state({ contribs: [world.tree.leaves()[0] as bigint, neverFunded], balA: 60n, balB: 39n, closingFee: 1n, nonce: 9n }));
    const built = submitStateWitness({ root: world.tree.root, channel: signed, contribProofs: [world.tree.proof(0), world.tree.emptyProof()] });
    expect(await satisfies('submit_state', built.input)).toBe(false);
  });

  it('rejects a forged signature, a wrong nonce and a wrong window', async () => {
    const c = submitCase();
    const forged = c.ch.sign(c.signed.state, { b: new TestChannel().keyB });
    expect(await satisfies('submit_state', submitStateWitness({ root: c.world.tree.root, channel: forged, contribProofs: c.proofs }).input)).toBe(false);

    const wrongNonce = submitStateWitness({ root: c.world.tree.root, channel: c.signed, contribProofs: c.proofs });
    wrongNonce.input.nonce = (wrongNonce.input.nonce as bigint) + 1n;
    expect(await satisfies('submit_state', wrongNonce.input)).toBe(false);

    const wrongWindow = submitStateWitness({ root: c.world.tree.root, channel: c.signed, contribProofs: c.proofs });
    wrongWindow.input.window = 60n;
    expect(await satisfies('submit_state', wrongWindow.input)).toBe(false);
  });
});

describe('Groth16 proofs', () => {
  it('finalize, reclaim and submit-state proofs verify and are bound to their public signals', async () => {
    const cases = [
      ['finalize', finalizeWitness(finalizeCase())],
      ['reclaim', reclaimWitness(reclaimCase())],
      ['submit_state', (() => {
        const c = submitCase();
        return submitStateWitness({ root: c.world.tree.root, channel: c.signed, contribProofs: c.proofs });
      })()],
    ] as const;
    for (const [name, built] of cases) {
      const { proof, publicSignals } = await prove(name, built.input);
      expect(publicSignals).toEqual(built.publicSignals.map(String));
      const vk = verificationKey(name);
      expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
      const tampered = [...publicSignals];
      tampered[tampered.length - 1] = (BigInt(tampered[tampered.length - 1] as string) + 1n).toString();
      expect(await snarkjs.groth16.verify(vk, tampered, proof)).toBe(false);
    }
  });
});
