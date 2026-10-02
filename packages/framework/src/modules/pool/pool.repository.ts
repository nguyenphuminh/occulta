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

  constructor(wallet: WalletService, networkId?: string) {
    this.wallet = wallet;
    this.networkId = networkId;
  }

  load(accountId?: string): PoolSection {
    return this.wallet.readSection(SECTION, PoolSectionSchema, accountId, this.networkId) ?? { syncedBlock: -1n, notes: [] };
  }

  save(section: PoolSection, accountId?: string): Promise<void> {
    return this.wallet.writeSection(SECTION, toJson(section), accountId, this.networkId);
  }
}
