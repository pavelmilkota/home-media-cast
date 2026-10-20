import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DataStore } from 'yt-cast-receiver';

/**
 * Small key-value store for the receiver (device id, paired screens) and our own switch.
 * Replaces the library's default store, which writes before its own async init has finished.
 * With no path it only keeps values in memory (tests).
 */
export class JsonFileDataStore extends DataStore {
  private readonly values = new Map<string, unknown>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path?: string) {
    super();
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(saved)) this.values.set(key, value);
    } catch (e) {
      // A missing file is the first run. A corrupt one is dropped: the phones just pair again.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.logger?.warn?.('Ignoring unreadable store file');
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
    await this.flush();
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  private flush(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    // Serialised, and written via a temp file so a crash never leaves half a JSON document.
    this.writing = this.writing.then(async () => {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.values)), { mode: 0o600 });
      await rename(tmp, path);
    });
    return this.writing;
  }
}
