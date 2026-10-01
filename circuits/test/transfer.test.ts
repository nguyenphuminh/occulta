import { describe, expect, it } from 'vitest';
import * as snarkjs from 'snarkjs';
import {
  FIELD_SIZE,
  dummyInput,
  hash2,
  toField,
  transferWitness,
  type CircuitInput,
  type TransferWitnessInput,
} from '@occulta/framework/protocol';
import { prove, publicSignalNames, satisfies, verificationKey } from './helpers.ts';
import { ETH, EXT, TestChannel, USDG, World, note, person } from './world.ts';

const relayer = person();

function simpleTransfer(): TransferWitnessInput {
  const world = new World();
  const alice = person();
  const bob = person();
  const input = world.addPersonal(note(100n, ETH, alice.ownerTag), alice);
  return {
    root: world.tree.root,
    token: ETH,
    inputs: [input, dummyInput(ETH)],
    outputs: [note(30n, ETH, bob.ownerTag), note(69n, ETH, alice.ownerTag), note(1n, ETH, relayer.ownerTag)],
    publicAmount: 0n,
    extDataHash: EXT,
  };
}

/** Alice 60 and Bob 40 in USDG, closing at 45 / 54 with a closing fee of 1. */
function cooperativeClose(stateOverrides = {}) {
  const world = new World();
  const ch = new TestChannel();
  const cA = world.addContribution(ch.contributionNote(60n, USDG, 'A'), ch.alice.ownerTag);
  const cB = world.addContribution(ch.contributionNote(40n, USDG, 'B'), ch.bob.ownerTag);
  const commitments = [world.tree.leaves()[0] as bigint, world.tree.leaves()[1] as bigint] as const;
  const signed = ch.sign(ch.state({ contribs: commitments, balA: 45n, balB: 54n, closingFee: 1n, nonce: 9_123_456n, final: true, ...stateOverrides }));
  const w: TransferWitnessInput = {
    root: world.tree.root,
    token: USDG,
    inputs: [world.refresh(cA), world.refresh(cB)],
    outputs: ch.closeOutputs(signed, USDG, relayer.ownerTag),
    publicAmount: 0n,
    extDataHash: EXT,
    channel: signed,
  };
  return { world, ch, signed, w };
}

const ok = (w: TransferWitnessInput) => satisfies('transfer', transferWitness(w).input);

/** What an attacker would do: set output amounts the framework refuses to build, with matching commitments. */
function forceOutputs(input: CircuitInput, amounts: bigint[]): void {
  const owners = input.outOwner as bigint[];
  const salts = input.outSalt as bigint[];
  input.outAmount = amounts;
  input.outCommitment = amounts.map((amount, k) =>
    hash2(toField(((input.token as bigint) << 64n) + amount), hash2(owners[k] as bigint, salts[k] as bigint)),
  );
}

describe('transfer circuit', () => {
  it('exposes exactly the intended public signals', () => {
    expect(publicSignalNames('transfer')).toEqual([
      'root',
      'publicAmount',
      'publicToken',
      'extDataHash',
      'inNullifier[0]',
      'inNullifier[1]',
      'outCommitment[0]',
      'outCommitment[1]',
      'outCommitment[2]',
    ]);
  });

  describe('accepts', () => {
    it('a private transfer with one real input and one dummy', async () => {
      expect(await ok(simpleTransfer())).toBe(true);
    });

    it('two real inputs', async () => {
      const world = new World();
      const alice = person();
      const a = world.addPersonal(note(70n, USDG, alice.ownerTag), alice);
      const b = world.addPersonal(note(50n, USDG, alice.ownerTag), alice);
      const w: TransferWitnessInput = {
        root: world.tree.root,
        token: USDG,
        inputs: [world.refresh(a), world.refresh(b)],
        outputs: [note(100n, USDG, person().ownerTag), note(19n, USDG, alice.ownerTag), note(1n, USDG, relayer.ownerTag)],
        publicAmount: 0n,
        extDataHash: EXT,
      };
      expect(await ok(w)).toBe(true);
    });

    it('a withdrawal that reveals the token and the public amount', async () => {
      const w = { ...simpleTransfer(), token: ETH };
      w.outputs = [note(40n, ETH, person().ownerTag), note(0n, ETH, person().ownerTag), note(1n, ETH, relayer.ownerTag)];
      w.publicAmount = 59n;
      expect(await ok(w)).toBe(true);
    });

    it('a withdrawal of USDG', async () => {
      const world = new World();
      const alice = person();
      const input = world.addPersonal(note(1_000_000n, USDG, alice.ownerTag), alice);
      const w: TransferWitnessInput = {
        root: world.tree.root,
        token: USDG,
        inputs: [input, dummyInput(USDG)],
        outputs: [note(0n, USDG, alice.ownerTag), note(0n, USDG, alice.ownerTag), note(5n, USDG, relayer.ownerTag)],
        publicAmount: 999_995n,
        extDataHash: EXT,
      };
      expect(await ok(w)).toBe(true);
    });

    it('a cooperative close with both contributions', async () => {
      expect(await ok(cooperativeClose().w)).toBe(true);
    });

    it('a cooperative close of a state that lists only one contribution', async () => {
      const world = new World();
      const ch = new TestChannel();
      const cA = world.addContribution(ch.contributionNote(60n, ETH, 'A'), ch.alice.ownerTag);
      const signed = ch.sign(ch.state({ contribs: [world.tree.leaves()[0] as bigint, 0n], balA: 59n, balB: 0n, closingFee: 1n, final: true }));
      const w: TransferWitnessInput = {
        root: world.tree.root,
        token: ETH,
        inputs: [cA, dummyInput(ETH)],
        outputs: ch.closeOutputs(signed, ETH, relayer.ownerTag),
        publicAmount: 0n,
        extDataHash: EXT,
        channel: signed,
      };
      expect(await ok(w)).toBe(true);
    });
  });

  describe('rejects (BRD 2.2.3 / 2.2.9 negative cases)', () => {
    it('the tampering helper itself keeps an honest witness valid', async () => {
      const built = transferWitness(simpleTransfer());
      forceOutputs(built.input, [30n, 69n, 1n]);
      expect(await satisfies('transfer', built.input)).toBe(true);
    });

    it('a negative amount that wraps around the field', async () => {
      // 101 + (FIELD_SIZE - 2) + 1 wraps around to 100 in the field: only the range check stops it.
      const built = transferWitness(simpleTransfer());
      forceOutputs(built.input, [101n, FIELD_SIZE - 2n, 1n]);
      expect(await satisfies('transfer', built.input)).toBe(false);
    });

    it('an amount at 2^64', async () => {
      const built = transferWitness(simpleTransfer());
      forceOutputs(built.input, [1n << 64n, 0n, 0n]);
      expect(await satisfies('transfer', built.input)).toBe(false);
    });

    it('unbalanced sums', async () => {
      const w = simpleTransfer();
      w.outputs = [note(31n, ETH, person().ownerTag), note(69n, ETH, person().ownerTag), note(1n, ETH, relayer.ownerTag)];
      expect(await ok(w)).toBe(false);
    });

    it('a fake nullifier', async () => {
      const built = transferWitness(simpleTransfer());
      const inNullifier = built.input.inNullifier as bigint[];
      inNullifier[0] = (inNullifier[0] as bigint) + 1n;
      expect(await satisfies('transfer', built.input)).toBe(false);
    });

    it('an input that is not in the tree under the root', async () => {
      const w = simpleTransfer();
      w.root = w.root + 1n;
      expect(await ok(w)).toBe(false);
    });

    it('spending without the owner secret', async () => {
      const built = transferWitness(simpleTransfer());
      (built.input.inSecret as bigint[])[0] = person().secret;
      expect(await satisfies('transfer', built.input)).toBe(false);
    });

    it('a public token on an internal transfer, or a wrong token on a withdrawal', async () => {
      const internal = transferWitness(simpleTransfer());
      internal.input.publicToken = USDG;
      expect(await satisfies('transfer', internal.input)).toBe(false);

      const w = simpleTransfer();
      w.outputs = [note(40n, ETH, person().ownerTag), note(0n, ETH, person().ownerTag), note(1n, ETH, relayer.ownerTag)];
      w.publicAmount = 59n;
      const withdrawal = transferWitness(w);
      withdrawal.input.publicToken = USDG;
      expect(await satisfies('transfer', withdrawal.input)).toBe(false);
    });

    it('mixing tokens between inputs and outputs', async () => {
      const w = simpleTransfer();
      w.outputs = [note(30n, USDG, person().ownerTag), note(69n, ETH, person().ownerTag), note(1n, ETH, relayer.ownerTag)];
      expect(await ok(w)).toBe(false);
    });

    it('a token outside 160 bits', async () => {
      const built = transferWitness(simpleTransfer());
      built.input.token = 1n << 160n;
      expect(await satisfies('transfer', built.input)).toBe(false);
    });

    it('cooperative close outputs that do not match the channel state', async () => {
      const swapped = cooperativeClose();
      const [a, b, fee] = swapped.w.outputs;
      swapped.w.outputs = [{ ...a, amount: 54n }, { ...b, amount: 45n }, fee];
      expect(await ok(swapped.w)).toBe(false);

      const stolen = cooperativeClose();
      const [, b2, fee2] = stolen.w.outputs;
      stolen.w.outputs = [{ ...stolen.w.outputs[0], ownerTag: person().ownerTag }, b2, fee2];
      expect(await ok(stolen.w)).toBe(false);

      const greedyFee = cooperativeClose();
      const [a3, b3, f3] = greedyFee.w.outputs;
      greedyFee.w.outputs = [{ ...a3, amount: 44n }, b3, { ...f3, amount: 2n }];
      expect(await ok(greedyFee.w)).toBe(false);
    });

    it('a payout salt that is not derived from the state', async () => {
      const c = cooperativeClose();
      const [a, b, fee] = c.w.outputs;
      c.w.outputs = [a, { ...b, salt: b.salt + 1n }, fee];
      expect(await ok(c.w)).toBe(false);
    });

    it('a forged signature', async () => {
      const c = cooperativeClose();
      c.w.channel = c.ch.sign(c.signed.state, { b: new TestChannel().keyB });
      expect(await ok(c.w)).toBe(false);
    });

    it('a state that is not final', async () => {
      expect(await ok(cooperativeClose({ final: false }).w)).toBe(false);
    });

    it('a channel input that the state does not list', async () => {
      const c = cooperativeClose();
      const listedOnlyA = c.ch.sign({ ...c.signed.state, contribs: [c.signed.state.contribs[0], 0n], balA: 59n, balB: 40n });
      c.w.channel = listedOnlyA;
      c.w.outputs = c.ch.closeOutputs(listedOnlyA, USDG, relayer.ownerTag);
      expect(await ok(c.w)).toBe(false);
    });

    it('leaving a listed contribution unspent (mixed close)', async () => {
      // The state lists both contributions; the closer spends Alice's and a personal note of equal value instead of Bob's.
      const c = cooperativeClose();
      const mallory = person();
      const fake = c.world.addPersonal(note(40n, USDG, mallory.ownerTag), mallory);
      c.w.root = c.world.tree.root;
      c.w.inputs = [c.world.refresh(c.w.inputs[0]), fake];
      expect(await ok(c.w)).toBe(false);
    });

    it('a mode flag that is not a bit', async () => {
      const built = transferWitness(simpleTransfer());
      (built.input.inMode as bigint[])[1] = 2n;
      expect(await satisfies('transfer', built.input)).toBe(false);
    });
  });

  describe('Groth16 proof', () => {
    it('verifies, and fails once any public signal is changed (recipient and ciphertexts are bound)', async () => {
      const built = transferWitness(simpleTransfer());
      const { proof, publicSignals } = await prove('transfer', built.input);
      expect(publicSignals).toEqual(built.publicSignals.map(String));
      const vk = verificationKey('transfer');
      expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
      for (let i = 0; i < publicSignals.length; i++) {
        const tampered = [...publicSignals];
        tampered[i] = (BigInt(tampered[i] as string) + 1n).toString();
        expect(await snarkjs.groth16.verify(vk, tampered, proof), `public signal ${i}`).toBe(false);
      }
    });
  });
});
