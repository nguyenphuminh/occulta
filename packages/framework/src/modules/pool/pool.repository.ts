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

/** The account's notes on the current network, kept inside the encrypted wallet. */
export class PoolRepository {
  private readonly wallet: WalletService;

  constructor(wallet: WalletService) {
    this.wallet = wallet;
  }

  load(accountId?: string): PoolSection {
    return this.wallet.readSection(SECTION, PoolSectionSchema, accountId) ?? { syncedBlock: -1n, notes: [] };
  }

  save(section: PoolSection, accountId?: string): Promise<void> {
    return this.wallet.writeSection(SECTION, toJson(section), accountId);
  }
}
