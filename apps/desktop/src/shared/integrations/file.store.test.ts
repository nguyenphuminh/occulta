import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from './file.store.ts';

describe('FileStore (the desktop data folder)', () => {
  const dirs: string[] = [];
  const fresh = async () => {
    const base = await mkdtemp(join(tmpdir(), 'occulta-store-'));
    dirs.push(base);
    return join(base, 'data');
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('round-trips values and returns null for missing keys', async () => {
    const store = new FileStore(await fresh());
    expect(await store.get('occulta.wallet')).toBeNull();
    await store.set('occulta.wallet', '{"a":1}');
    expect(await store.get('occulta.wallet')).toBe('{"a":1}');
    await store.delete('occulta.wallet');
    expect(await store.get('occulta.wallet')).toBeNull();
  });

  it('creates an owner-only folder and owner-only files, with no temporary files left', async () => {
    const dir = await fresh();
    const store = new FileStore(dir);
    await store.set('occulta.wallet', 'x');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(store.pathOf('occulta.wallet'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['occulta.wallet.json']);
  });

  it('applies concurrent writes in the order they were made', async () => {
    const store = new FileStore(await fresh());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set('k', `v${i}`)));
    expect(await store.get('k')).toBe('v19');
  });

  it('refuses keys that could escape the folder', () => {
    const store = new FileStore('/tmp/x');
    expect(() => store.pathOf('../etc/passwd')).toThrow(/Invalid storage key/);
  });
});
