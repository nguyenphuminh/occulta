import { describe, expect, it } from 'vitest';
import { BUILT_IN_NETWORKS } from '@occulta/framework';
import { formatAmount, parseAmount, tokenId, tokenName } from './amounts.ts';

const sepolia = BUILT_IN_NETWORKS.find((n) => n.id === 'arbitrum-sepolia')!;

describe('token amounts on the command line', () => {
  it('parses ETH with 18 decimals and USDG with 6', () => {
    expect(parseAmount('eth', '0.01')).toBe(10n ** 16n);
    expect(parseAmount('usdg', '1.5')).toBe(1_500_000n);
    expect(formatAmount('usdg', 1_500_000n)).toBe('1.5 USDG');
    expect(formatAmount('eth', 10n ** 18n)).toBe('1 ETH');
  });

  it('refuses zero amounts', () => {
    expect(() => parseAmount('eth', '0')).toThrow(/positive/);
  });

  it('maps token names to the pool’s token ids per network', () => {
    expect(tokenId('eth', sepolia)).toBe(0n);
    expect(tokenId('usdg', sepolia)).toBe(BigInt(sepolia.usdg));
    expect(tokenName(BigInt(sepolia.usdg), sepolia)).toBe('usdg');
    expect(() => tokenName(123n, sepolia)).toThrow(/Only ETH and USDG/);
  });
});
