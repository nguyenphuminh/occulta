import { describe, expect, it } from 'vitest';
import { BUILT_IN_NETWORKS } from '@occulta/framework';
import { shortAddress } from './addresses.ts';
import { networkLogo } from './networks.ts';

describe('addresses and networks as shown', () => {
  it('shortens an address to its start and end, as wallets show them', () => {
    expect(shortAddress('0x6412d4dc3b4bD2Eb3c0a3E0e2f6E1f9E8a4F3a9f')).toBe('0x6412…3a9f');
    const shielded = `occ${'0dc7f5d8'}${'ab'.repeat(60)}${'60ad8c91'}`;
    expect(shortAddress(shielded)).toBe('occ0dc7f5d8…60ad8c91');
    expect(shortAddress('0x1234')).toBe('0x1234'); // already short
  });

  it('shows Arbitrum’s logo for Arbitrum networks only', () => {
    expect(networkLogo(BUILT_IN_NETWORKS[0]!)).toMatch(/arbitrum-logomark.*\.svg|^data:image\/svg/);
    expect(networkLogo({ ...BUILT_IN_NETWORKS[0]!, id: 'dev', chainId: 412346 })).toBeNull();
  });
});
