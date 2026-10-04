import { z } from 'zod';

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>;

export const AccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['derived', 'imported']),
  /** Derivation index under m/44'/60'/0'/0 for derived accounts. */
  index: z.number().int().nonnegative().optional(),
  /** Only imported accounts keep their key; derived ones are re-derived from the phrase. */
  privateKey: hex.optional(),
  address,
  /** Never handed out as a fresh exit address once used (BRD 2.2.14.4). */
  used: z.boolean(),
});

/** Everything the wallet holds; stored only inside the encrypted envelope (BRD 2.2.14.6). */
export const WalletDocumentSchema = z.object({
  version: z.literal(1),
  mnemonic: z.string().nullable(),
  accounts: z.array(AccountSchema).min(1),
  activeAccountId: z.string(),
  networkId: z.string(),
  lastExportAt: z.number().nullable(),
  /** Per account and network data owned by other modules, keyed `${accountId}/${networkId}/${section}`. */
  sections: z.record(z.string(), z.unknown()),
});

/** The encrypted vault: stored by hosts and handed out as the export file. */
export const EnvelopeSchema = z.object({
  format: z.literal('occulta-wallet'),
  version: z.literal(1),
  kdf: z.object({ name: z.literal('scrypt'), N: z.number().int(), r: z.number().int(), p: z.number().int(), salt: hex }),
  nonce: hex,
  ciphertext: hex,
});

export type Account = z.infer<typeof AccountSchema>;
export type WalletDocument = z.infer<typeof WalletDocumentSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
