import { z } from 'zod';
import { AppError } from '../../shared/errors/AppError.ts';
import { jsonSafe } from '../../shared/utils/json.ts';
import type { WalletService } from '../wallet/index.ts';
import { ChannelRecordSchema, type ChannelRecord } from './channel.schema.ts';

const SECTION = 'channels';
const Schema = z.array(ChannelRecordSchema);

/** The account's channels on one network (bound like the pool's notes), inside the encrypted wallet. */
export class ChannelRepository {
  private readonly wallet: WalletService;
  private readonly networkId: string | undefined;
  private closed = false;

  constructor(wallet: WalletService, networkId?: string) {
    this.wallet = wallet;
    this.networkId = networkId;
  }

  all(accountId?: string): ChannelRecord[] {
    return this.wallet.readSection(SECTION, Schema, accountId, this.networkId) ?? [];
  }

  get(id: string, accountId?: string): ChannelRecord | undefined {
    return this.all(accountId).find((c) => c.id === id);
  }

  /**
   * Called when the session using it stops (lock, or a switch of account or network): work still
   * running in that session must not overwrite what the next session saves.
   */
  close(): void {
    this.closed = true;
  }

  async save(record: ChannelRecord, accountId?: string): Promise<void> {
    if (this.closed) throw new AppError(409, 'SESSION_STOPPED', 'This session has stopped; its changes are not saved');
    const others = this.all(accountId).filter((c) => c.id !== record.id);
    await this.wallet.writeSection(SECTION, jsonSafe([...others, record]), accountId, this.networkId);
  }
}
