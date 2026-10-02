import { z } from 'zod';
import { jsonSafe } from '../../shared/utils/json.ts';
import type { WalletService } from '../wallet/index.ts';
import { ChannelRecordSchema, type ChannelRecord } from './channel.schema.ts';

const SECTION = 'channels';
const Schema = z.array(ChannelRecordSchema);

/** The account's channels on the current network, inside the encrypted wallet. */
export class ChannelRepository {
  private readonly wallet: WalletService;

  constructor(wallet: WalletService) {
    this.wallet = wallet;
  }

  all(accountId?: string): ChannelRecord[] {
    return this.wallet.readSection(SECTION, Schema, accountId) ?? [];
  }

  get(id: string, accountId?: string): ChannelRecord | undefined {
    return this.all(accountId).find((c) => c.id === id);
  }

  async save(record: ChannelRecord, accountId?: string): Promise<void> {
    const others = this.all(accountId).filter((c) => c.id !== record.id);
    await this.wallet.writeSection(SECTION, jsonSafe([...others, record]), accountId);
  }
}
