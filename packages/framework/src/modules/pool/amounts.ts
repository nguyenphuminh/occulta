/** Preset amounts in powers of ten (BRD 2.2.2), in base units. ETH has 18 decimals, USDG 6. */
export const ETH_PRESETS = [10n ** 16n, 10n ** 17n, 10n ** 18n, 10n ** 19n]; // 0.01, 0.1, 1, 10 ETH
export const USDG_PRESETS = [10n ** 6n, 10n ** 7n, 10n ** 8n, 10n ** 9n]; // 1, 10, 100, 1,000 USDG

/** Round amounts are powers of ten in base units; anything else gets a hint, never a block. */
export function isRoundAmount(amount: bigint): boolean {
  if (amount <= 0n) return false;
  let rest = amount;
  while (rest % 10n === 0n) rest /= 10n;
  return rest === 1n;
}
