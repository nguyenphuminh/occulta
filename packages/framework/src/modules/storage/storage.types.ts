/**
 * Where a host keeps the framework's data: the browser's IndexedDB on the website, a data folder on
 * the desktop client, memory in tests. Values are opaque strings; the wallet only ever stores its
 * encrypted vault through this interface (BRD 2.2.14.3: nothing is stored unencrypted).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
