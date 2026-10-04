import { z } from 'zod';
import { ownerTagOf } from '../../shared/protocol/index.ts';
import type { WalletService } from '../wallet/index.ts';
import { channelSecrets, derivePoolKeys, type ChannelSecrets, type PoolKeys } from './keys.service.ts';

const KeysSectionSchema = z.object({ channelCount: z.number().int().nonnegative() });
const SECTION = 'keys';

/**
 * Pool keys of the wallet's accounts, derived on demand while the wallet is unlocked (never stored),
 * and the per-account counter that gives every channel fresh secrets.
 */
export class KeyRing {
  private readonly wallet: WalletService;
  private readonly cache = new Map<string, Promise<PoolKeys>>();

  constructor(wallet: WalletService) {
    this.wallet = wallet;
  }

  poolKeys(accountId = this.wallet.activeAccount().id): Promise<PoolKeys> {
    const signer = this.wallet.signer(accountId); // throws while locked
    let keys = this.cache.get(signer.address);
    if (!keys) {
      keys = derivePoolKeys(signer);
      this.cache.set(signer.address, keys);
    }
    return keys;
  }

  /** Forgets derived keys, e.g. when the wallet locks. */
  clear(): void {
    this.cache.clear();
  }

  /** Without `networkId`, the selected network at the time of the call. */
  channelCount(accountId?: string, networkId?: string): number {
    return this.wallet.readSection(SECTION, KeysSectionSchema, accountId, networkId)?.channelCount ?? 0;
  }

  /** Reserves the next channel index and returns its secrets. */
  async newChannel(accountId?: string, networkId?: string): Promise<{ index: number; secrets: ChannelSecrets }> {
    const index = this.channelCount(accountId, networkId);
    await this.wallet.writeSection(SECTION, { channelCount: index + 1 }, accountId, networkId);
    return { index, secrets: channelSecrets(await this.poolKeys(accountId), index) };
  }

  /** Owner tags of all channel payout/refund secrets in use (plus a margin), for note discovery. */
  async channelTags(accountId?: string, networkId?: string, margin = 16): Promise<Map<bigint, number>> {
    const keys = await this.poolKeys(accountId);
    const tags = new Map<bigint, number>();
    for (let i = 0; i < this.channelCount(accountId, networkId) + margin; i++) tags.set(ownerTagOf(channelSecrets(keys, i).tagSecret), i);
    return tags;
  }
}
