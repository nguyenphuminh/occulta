import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, type KeyValueStore } from '@occulta/framework';

/**
 * The desktop data folder (BRD 2.2.15). The framework only ever stores its encrypted vault here,
 * so the folder holds one file whose content is exactly a website export file. Writes are atomic
 * (temporary file, then rename), owner-only, and applied in the order they were made.
 */
export class FileStore implements KeyValueStore {
  private readonly dir: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.pathOf(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  set(key: string, value: string): Promise<void> {
    return this.queue(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const path = this.pathOf(key);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, path);
    });
  }

  delete(key: string): Promise<void> {
    return this.queue(() => rm(this.pathOf(key), { force: true }));
  }

  /** The file that holds a key's value. */
  pathOf(key: string): string {
    if (!/^[a-z0-9.-]+$/i.test(key)) throw new AppError(400, 'INVALID_KEY', 'Invalid storage key');
    return join(this.dir, `${key}.json`);
  }

  private queue(write: () => Promise<void>): Promise<void> {
    const run = this.writes.then(write);
    this.writes = run.catch(() => undefined);
    return run;
  }
}
