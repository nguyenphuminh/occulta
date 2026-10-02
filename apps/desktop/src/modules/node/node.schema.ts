import { z } from 'zod';
import { TOKEN_NAMES } from '../../shared/utils/amounts.ts';

const token = z.enum(TOKEN_NAMES);
const amount = z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal amount such as 0.01');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address') as z.ZodType<`0x${string}`>;

export const emptySchema = z.object({});
export const useAccountSchema = z.object({ account: z.string().min(1) });
export const importAccountSchema = z.object({ privateKey: z.string().min(1) });
export const useNetworkSchema = z.object({ network: z.string().min(1) });
export const sendPublicSchema = z.object({ token, to: address, amount });
export const depositSchema = z.object({ token, amount });
export const transferSchema = z.object({ to: z.string().min(1), token, amount });
/** Without `to`, the withdrawal goes to a never-used account of this wallet (BRD 2.2.14.4). */
export const withdrawSchema = z.object({ token, amount, to: address.optional() });
export const openChannelSchema = z.object({
  invite: z.string().min(1),
  token,
  amount,
  /** What the other side is asked to fund. */
  peerAmount: amount.optional(),
  /** Dispute window in seconds. */
  window: z.coerce.number().int().positive().optional(),
});
export const payChannelSchema = z.object({ channel: z.string().min(1), amount });
export const channelSchema = z.object({ channel: z.string().min(1) });
export const exportSchema = z.object({ path: z.string().min(1) });

export type SendPublicInput = z.infer<typeof sendPublicSchema>;
export type DepositInput = z.infer<typeof depositSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type WithdrawInput = z.infer<typeof withdrawSchema>;
export type OpenChannelInput = z.infer<typeof openChannelSchema>;
export type PayChannelInput = z.infer<typeof payChannelSchema>;
