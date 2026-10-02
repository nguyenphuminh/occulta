import type { KeyValueStore } from '@occulta/framework';

const STORE = 'kv';

/**
 * The website's storage: IndexedDB in this browser. The framework only ever puts its encrypted
 * vault here (BRD 2.2.14.3). Writes are applied in the order they were made.
 */
export class IdbStore implements KeyValueStore {
  private readonly name: string;
  private db: Promise<IDBDatabase> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(name = 'occulta') {
    this.name = name;
  }

  async get(key: string): Promise<string | null> {
    const value = await this.request('readonly', (store) => store.get(key));
    return typeof value === 'string' ? value : null;
  }

  set(key: string, value: string): Promise<void> {
    return this.queue(() => this.request('readwrite', (store) => store.put(value, key)));
  }

  delete(key: string): Promise<void> {
    return this.queue(() => this.request('readwrite', (store) => store.delete(key)));
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  private async request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  private queue(write: () => Promise<unknown>): Promise<void> {
    const run = this.writes.then(write).then(() => undefined);
    this.writes = run.catch(() => undefined);
    return run;
  }
}
