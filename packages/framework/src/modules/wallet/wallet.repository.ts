import type { KeyValueStore } from '../storage/index.ts';

const VAULT_KEY = 'occulta.wallet';

/** Reads and writes the encrypted vault; never sees plaintext. */
export class WalletRepository {
  private readonly store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.store = store;
  }

  load(): Promise<string | null> {
    return this.store.get(VAULT_KEY);
  }

  save(envelope: string): Promise<void> {
    return this.store.set(VAULT_KEY, envelope);
  }

  remove(): Promise<void> {
    return this.store.delete(VAULT_KEY);
  }
}
