import { describe, expect, it } from 'vitest';
import { ETH_PRESETS, USDG_PRESETS, isRoundAmount } from './amounts.ts';
import { selectInputs, type SpendableNote } from './pool.service.ts';

const note = (amount: bigint, n = Number(amount)): SpendableNote => ({
  commitment: BigInt(n),
  leafIndex: n,
  amount,
  token: 0n,
  ownerTag: 1n,
  salt: 2n,
  secret: 'spending',
  spent: false,
  unlockSecret: 3n,
});
const amounts = (picked: ReturnType<typeof selectInputs>) => (typeof picked === 'string' ? picked : picked.map((n) => n.amount));

describe('input selection (two inputs per transfer)', () => {
  it('prefers the smallest single note that covers the amount', () => {
    expect(amounts(selectInputs([note(50n), note(200n), note(120n)], 100n))).toEqual([120n]);
  });

  it('otherwise uses the cheapest covering pair', () => {
    expect(amounts(selectInputs([note(40n), note(70n), note(65n), note(10n)], 100n))).toEqual([40n, 65n]);
  });

  it('reports fragmentation when only three or more notes together cover the amount', () => {
    expect(selectInputs([note(40n), note(40n, 41), note(40n, 42)], 100n)).toBe('fragmented');
  });

  it('reports insufficient funds', () => {
    expect(selectInputs([note(40n), note(50n)], 100n)).toBe('insufficient');
    expect(selectInputs([], 1n)).toBe('insufficient');
  });
});

describe('round amounts (BRD 2.2.2)', () => {
  it('are powers of ten in base units, including every preset', () => {
    for (const preset of [...ETH_PRESETS, ...USDG_PRESETS]) expect(isRoundAmount(preset)).toBe(true);
    expect(isRoundAmount(1n)).toBe(true);
    expect(isRoundAmount(1_000_000n)).toBe(true);
    expect(isRoundAmount(1_500_000n)).toBe(false);
    expect(isRoundAmount(30n)).toBe(false);
    expect(isRoundAmount(0n)).toBe(false);
  });

  it('presets fit the 64-bit amount range', () => {
    for (const preset of [...ETH_PRESETS, ...USDG_PRESETS]) expect(preset < 2n ** 64n).toBe(true);
  });
});
