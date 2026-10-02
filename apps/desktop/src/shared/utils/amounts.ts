import { formatUnits, parseUnits } from 'viem';
import { AppError, type NetworkConfig } from '@occulta/framework';

/** The two tokens of the pool, as users name them on the command line. */
export const TOKEN_NAMES = ['eth', 'usdg'] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

const DECIMALS: Record<TokenName, number> = { eth: 18, usdg: 6 };

/** The token as the framework numbers it: 0 for ETH, the USDG contract address otherwise. */
export function tokenId(name: TokenName, network: NetworkConfig): bigint {
  return name === 'eth' ? 0n : BigInt(network.usdg);
}

export function tokenName(token: bigint, network: NetworkConfig): TokenName {
  if (token === 0n) return 'eth';
  if (token === BigInt(network.usdg)) return 'usdg';
  throw new AppError(400, 'TOKEN_NOT_SUPPORTED', 'Only ETH and USDG are supported');
}

/** "0.01" ETH → base units. */
export function parseAmount(name: TokenName, text: string): bigint {
  const value = parseUnits(text, DECIMALS[name]);
  if (value <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be positive');
  return value;
}

/** Base units → "0.01 ETH". */
export function formatAmount(name: TokenName, value: bigint): string {
  return `${formatUnits(value, DECIMALS[name])} ${name.toUpperCase()}`;
}
