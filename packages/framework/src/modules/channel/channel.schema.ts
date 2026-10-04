import { z } from 'zod';
import { bigintString as big, hexString } from '../../shared/utils/json.ts';

const pk = z.tuple([big, big]).readonly();
const encryptionKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>;
export const SignatureSchema = z.object({ R8x: big, R8y: big, S: big });
export const StateSchema = z.object({
  contribs: z.tuple([big, big]).readonly(),
  balA: big,
  balB: big,
  payoutA: big,
  payoutB: big,
  closingFee: big,
  nonce: big,
  final: z.boolean(),
});
const ParamsSchema = z.object({ pkA: pk, pkB: pk, channelSecret: big, window: big });
const ContributionSchema = z.object({ amount: big, salt: big });
const SignedSchema = z.object({ state: StateSchema, sigA: SignatureSchema.nullable(), sigB: SignatureSchema.nullable() });

export const CHANNEL_STATUSES = ['opening', 'funding', 'live', 'closing', 'closed', 'disputing', 'settled', 'cancelled'] as const;

/** Everything a party keeps about a channel (BRD 2.2.14.6 lists it among the exported data). */
export const ChannelRecordSchema = z.object({
  id: z.string(),
  /** A opened the channel (and is "Alice" in the BRD); B accepted the invite. */
  role: z.enum(['A', 'B']),
  /** This party's channel index in its key ring: its signing key and payout/refund tag secret. */
  index: z.number().int().nonnegative(),
  peer: z.object({ peerId: z.string(), addrs: z.array(z.string()) }),
  token: big,
  status: z.enum(CHANNEL_STATUSES),
  params: ParamsSchema,
  encPubA: encryptionKey,
  encPubB: encryptionKey,
  contribA: ContributionSchema,
  /** Null when B contributes nothing. */
  contribB: ContributionSchema.nullable(),
  state0: SignedSchema,
  latest: SignedSchema,
  /** This party's outstanding proposal (signed by it, not yet by the other side). */
  pending: z.object({ prevHash: big, state: StateSchema, sig: SignatureSchema }).nullable(),
  /**
   * Every fully signed state after state 0 as [balA, balB, closingFee, nonce, final] (the other
   * fields never change), so the payout of whichever state a dispute settles can be rebuilt.
   */
  history: z.array(z.tuple([big, big, big, big, z.boolean()])),
  closeTx: hexString.nullable(),
  /** When this side saved the channel (epoch ms); channels from before it was kept have none. */
  createdAt: z.number().int().nonnegative().optional(),
});

export type ChannelRecord = z.output<typeof ChannelRecordSchema>;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
export type OpenMessage = z.output<typeof OpenMessageSchema>;
export type ConfirmMessage = z.output<typeof ConfirmMessageSchema>;
export type ProposeMessage = z.output<typeof ProposeMessageSchema>;

// --- messages between the two parties (over P2PService) ---

export const OpenMessageSchema = z.object({
  type: z.literal('open'),
  channelId: z.string().regex(/^[0-9a-f]{32}$/),
  token: big,
  amountA: big,
  amountB: big,
  window: big,
  closingFee: big,
  nonce0: big,
  shareA: big,
  pkA: pk,
  tagA: big,
  encPubA: encryptionKey,
  contribA: ContributionSchema,
  /** How A reaches B's answers later (A's own relay addresses). */
  addrsA: z.array(z.string()),
});

export const OpenReplySchema = z.object({
  shareB: big,
  pkB: pk,
  tagB: big,
  encPubB: encryptionKey,
  contribB: ContributionSchema.nullable(),
  sigB0: SignatureSchema,
});

export const ConfirmMessageSchema = z.object({
  type: z.literal('confirm'),
  channelId: z.string(),
  sigA0: SignatureSchema,
  /** State 1 (both contributions), absent when B contributes nothing. */
  state1: StateSchema.nullable(),
  sigA1: SignatureSchema.nullable(),
});

export const ConfirmReplySchema = z.object({ sigB1: SignatureSchema.nullable() });

export const ProposeMessageSchema = z.object({
  type: z.enum(['pay', 'close']),
  channelId: z.string(),
  prevHash: big,
  state: StateSchema,
  sig: SignatureSchema,
  /** The proposer's signature of the state it builds on, which completes it if our copy lacks it. */
  prevSig: SignatureSchema,
});

export const ProposeReplySchema = z.object({ sig: SignatureSchema });

/** Either side cancels an opening nobody funded (BRD 2.2.7). */
export const CancelMessageSchema = z.object({ type: z.literal('cancel'), channelId: z.string() });

export const ChannelMessageSchema = z.discriminatedUnion('type', [OpenMessageSchema, ConfirmMessageSchema, ProposeMessageSchema, CancelMessageSchema]);
