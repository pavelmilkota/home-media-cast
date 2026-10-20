import { Injectable } from '@nestjs/common';
import type { StreamsCacheStats } from '@home-media-cast/shared';
import { asc, count, eq, lt, min } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { streamCache } from '../db/schema.js';

export interface CachedStreams {
  results: unknown[];
  errors: string[];
  /** Epoch ms, when the provider answered. */
  fetchedAt: number;
}

const MAX_AGE_MS = 30 * 24 * 3_600_000;
const MAX_ROWS = 500;

/**
 * The last raw AIOStreams answer per title, in SQLite. Rows hold provider links (which may embed a
 * debrid key), so nothing here logs or returns row contents beyond `get` to the service.
 */
@Injectable()
export class StreamsCacheStore {
  constructor(private readonly db: DbService) {}

  get(key: string): CachedStreams | undefined {
    const row = this.db.orm.select().from(streamCache).where(eq(streamCache.key, key)).get();
    if (!row) return undefined;
    try {
      const results: unknown = JSON.parse(row.results);
      const errors: unknown = JSON.parse(row.errors);
      if (!Array.isArray(results) || !Array.isArray(errors)) throw new TypeError('not an array');
      return { results, errors: errors.map(String), fetchedAt: row.fetchedAt };
    } catch {
      this.db.orm.delete(streamCache).where(eq(streamCache.key, key)).run();
      return undefined;
    }
  }

  put(
    key: string,
    { results, errors }: { results: unknown[]; errors: string[] },
    now = Date.now(),
  ): void {
    const values = {
      results: JSON.stringify(results),
      errors: JSON.stringify(errors),
      fetchedAt: now,
    };
    this.db.orm
      .insert(streamCache)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: streamCache.key, set: values })
      .run();
    this.prune(now);
  }

  /** Removes every row; returns how many. */
  clear(): number {
    return this.db.orm.delete(streamCache).run().changes;
  }

  stats(): StreamsCacheStats {
    const row = this.db.orm
      .select({ entries: count(), oldest: min(streamCache.fetchedAt) })
      .from(streamCache)
      .get();
    return {
      entries: row?.entries ?? 0,
      ...(row?.oldest != null ? { oldestFetchedAt: row.oldest } : {}),
    };
  }

  private prune(now: number): void {
    this.db.orm
      .delete(streamCache)
      .where(lt(streamCache.fetchedAt, now - MAX_AGE_MS))
      .run();
    const excess = this.stats().entries - MAX_ROWS;
    if (excess <= 0) return;
    const oldest = this.db.orm
      .select({ key: streamCache.key })
      .from(streamCache)
      .orderBy(asc(streamCache.fetchedAt))
      .limit(excess)
      .all();
    for (const { key } of oldest)
      this.db.orm.delete(streamCache).where(eq(streamCache.key, key)).run();
  }
}
