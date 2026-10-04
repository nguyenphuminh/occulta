import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStore } from './idb.store.ts';

describe('IdbStore (the website’s storage)', () => {
  it('round-trips values, returns null for missing keys, and deletes', async () => {
    const store = new IdbStore('t1');
    expect(await store.get('occulta.wallet')).toBeNull();
    await store.set('occulta.wallet', '{"format":"occulta-wallet"}');
    expect(await store.get('occulta.wallet')).toBe('{"format":"occulta-wallet"}');
    await store.delete('occulta.wallet');
    expect(await store.get('occulta.wallet')).toBeNull();
  });

  it('keeps the last of many concurrent writes, and survives a new instance (a reload)', async () => {
    const store = new IdbStore('t2');
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.set('k', `v${i}`)));
    expect(await new IdbStore('t2').get('k')).toBe('v24');
  });
});
