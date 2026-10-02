import { z } from 'zod';

const uint = z.string().regex(/^\d+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/) as z.ZodType<`0x${string}`>;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>;

/** What a user's app sends a relayer: a proven transaction it cannot alter (BRD 2.2.11). */
export const RelayRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transact'), proof: z.array(uint).length(8), signals: z.array(uint).length(9), recipient: address, ciphertexts: hex }),
  z.object({ kind: z.literal('finalize'), proof: z.array(uint).length(8), signals: z.array(uint).length(9), ciphertexts: hex }),
  z.object({ kind: z.literal('reclaim'), proof: z.array(uint).length(8), signals: z.array(uint).length(8), ciphertexts: hex }),
  z.object({ kind: z.literal('submitState'), proof: z.array(uint).length(8), signals: z.array(uint).length(5) }),
]);

export const RelayerInfoSchema = z.object({
  chainId: z.number().int(),
  /** Where fee notes go. */
  shieldedAddress: z.string(),
  /** Quoted fee per accepted token, by lowercase token address (zero address = ETH). */
  fees: z.record(z.string(), uint),
});

export const RelayResultSchema = z.object({ txHash: hex });

export type RelayRequest = z.infer<typeof RelayRequestSchema>;
export type RelayerInfo = z.infer<typeof RelayerInfoSchema>;
export type RelayResult = z.infer<typeof RelayResultSchema>;

/** How the app reaches a relayer: over HTTP, or in-process (the desktop client relaying for itself, tests). */
export interface RelayerPort {
  info(): Promise<RelayerInfo>;
  submit(request: RelayRequest): Promise<RelayResult>;
}
