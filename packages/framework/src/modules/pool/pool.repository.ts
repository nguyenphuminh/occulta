import { AppError } from '../../shared/errors/AppError.ts';
import type { WalletService } from '../wallet/index.ts';
import { PoolSectionSchema, type PoolSection } from './pool.schema.ts';

const SECTION = 'pool';
const toJson = (s: PoolSection) => ({
  syncedBlock: s.syncedBlock.toString(),
  notes: s.notes.map((n) => ({
    ...n,
    commitment: n.commitment.toString(),
    amount: n.amount.toString(),
    token: n.token.toString(),
    ownerTag: n.ownerTag.toString(),
    salt: n.salt.toString(),
  })),
});

/**
 * The account's notes on one network, kept inside the encrypted wallet. Bound to a network, it keeps
 * writing there even if the user switches network while an operation is still running.
 */
export class PoolRepository {
  private readonly wallet: WalletService;
  private readonly networkId: string | undefined;
  private closed = false;

  constructor(wallet: WalletService, networkId?: string) {
    this.wallet = wallet;
    this.networkId = networkId;
  }

  load(accountId?: string): PoolSection {
    return this.wallet.readSection(SECTION, PoolSectionSchema, accountId, this.networkId) ?? { syncedBlock: -1n, notes: [] };
  }

  /**
   * Called when the session using it stops (lock, or a switch of account or network): work still
   * running in that session must not overwrite what the next session saves.
   */
  close(): void {
    this.closed = true;
  }

  async save(section: PoolSection, accountId?: string): Promise<void> {
    if (this.closed) throw new AppError(409, 'SESSION_STOPPED', 'This session has stopped; its changes are not saved');
    await this.wallet.writeSection(SECTION, toJson(section), accountId, this.networkId);
  }
}
