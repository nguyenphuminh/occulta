import { formatUnits, parseUnits } from 'viem';
import type { NetworkConfig } from '@occulta/framework';

export const TOKENS = ['eth', 'usdg'] as const;
export type TokenName = (typeof TOKENS)[number];

const DECIMALS: Record<TokenName, number> = { eth: 18, usdg: 6 };
export const SYMBOL: Record<TokenName, string> = { eth: 'ETH', usdg: 'USDG' };

/** The token as the framework numbers it: 0 for ETH, the network's USDG contract otherwise. */
export const tokenId = (name: TokenName, network: NetworkConfig): bigint => (name === 'eth' ? 0n : BigInt(network.usdg));
export const tokenName = (token: bigint): TokenName => (token === 0n ? 'eth' : 'usdg');

/** The user's text as base units, or null when it is not a positive amount with at most the token's decimals. */
export function parseAmount(name: TokenName, text: string): bigint | null {
  const value = text.trim();
  if (!/^\d+(\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > DECIMALS[name]) return null;
  const units = parseUnits(value, DECIMALS[name]);
  return units > 0n ? units : null;
}

export const formatAmount = (name: TokenName, value: bigint): string => `${formatUnits(value, DECIMALS[name])} ${SYMBOL[name]}`;
export const toDecimal = (name: TokenName, value: bigint): string => formatUnits(value, DECIMALS[name]);
