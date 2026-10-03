import { describe, expect, it } from 'vitest';
import { BUILT_IN_NETWORKS } from '@occulta/framework';
import { formatAmount, parseAmount, tokenId, tokenName } from './amounts.ts';

describe('amounts typed by the user', () => {
  it('reads decimal amounts in token units and refuses everything else', () => {
    expect(parseAmount('eth', '0.01')).toBe(10n ** 16n);
    expect(parseAmount('usdg', ' 12.5 ')).toBe(12_500_000n);
    for (const bad of ['', '0', '-1', '1e3', 'abc', '1.', '0.0000001']) expect(parseAmount('usdg', bad)).toBeNull();
  });

  it('formats base units with the symbol and maps tokens per network', () => {
    const sepolia = BUILT_IN_NETWORKS[0]!;
    expect(formatAmount('eth', 1500000000000000000n)).toBe('1.5 ETH');
    expect(tokenId('usdg', sepolia)).toBe(BigInt(sepolia.usdg));
    expect(tokenName(0n)).toBe('eth');
  });
});
