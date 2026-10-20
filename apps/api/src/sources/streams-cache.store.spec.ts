import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbService } from '../db/db.service.js';
import { streamCache } from '../db/schema.js';
import { StreamsCacheStore } from './streams-cache.store.js';

const DAY = 24 * 3_600_000;

describe('StreamsCacheStore', () => {
  let db: DbService;
  let store: StreamsCacheStore;

  beforeEach(() => {
    db = new DbService(':memory:');
    store = new StreamsCacheStore(db);
  });
  afterEach(() => db.onModuleDestroy());

  it('misses an unknown key', () => {
    expect(store.get('movie:tt1')).toBeUndefined();
  });

  it('round-trips results, errors and fetchedAt', () => {
    store.put('movie:tt1', { results: [{ a: 1 }], errors: ['x'] }, 1000);
    expect(store.get('movie:tt1')).toEqual({ results: [{ a: 1 }], errors: ['x'], fetchedAt: 1000 });
  });

  it('upserts a key', () => {
    store.put('movie:tt1', { results: [1], errors: [] }, 1000);
    store.put('movie:tt1', { results: [2], errors: [] }, 2000);
    expect(store.get('movie:tt1')).toMatchObject({ results: [2], fetchedAt: 2000 });
    expect(store.stats().entries).toBe(1);
  });

  it('prunes rows older than 30 days', () => {
    const now = 100 * DAY;
    store.put('movie:old', { results: [], errors: [] }, now - 31 * DAY);
    store.put('movie:new', { results: [], errors: [] }, now);
    expect(store.get('movie:old')).toBeUndefined();
    expect(store.get('movie:new')).toBeDefined();
  });

  it('keeps at most 500 rows, dropping the oldest', () => {
    for (let i = 0; i < 502; i++) store.put(`movie:${i}`, { results: [], errors: [] }, 1000 + i);
    expect(store.stats()).toEqual({ entries: 500, oldestFetchedAt: 1002 });
    expect(store.get('movie:0')).toBeUndefined();
    expect(store.get('movie:501')).toBeDefined();
  });

  it('treats a corrupt row as a miss and deletes it', () => {
    db.orm
      .insert(streamCache)
      .values({ key: 'movie:bad', results: '{', errors: '[]', fetchedAt: 1 })
      .run();
    expect(store.get('movie:bad')).toBeUndefined();
    expect(store.stats().entries).toBe(0);
  });

  it('clears and reports the count', () => {
    store.put('a', { results: [], errors: [] }, 1);
    store.put('b', { results: [], errors: [] }, 2);
    expect(store.clear()).toBe(2);
    expect(store.stats()).toEqual({ entries: 0 });
  });

  it('reports entries and the oldest fetch time', () => {
    expect(store.stats()).toEqual({ entries: 0 });
    store.put('a', { results: [], errors: [] }, 50);
    store.put('b', { results: [], errors: [] }, 20);
    expect(store.stats()).toEqual({ entries: 2, oldestFetchedAt: 20 });
  });
});

describe('stream_cache migration', () => {
  it('applies to a database already at 0001', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmc-db-'));
    const path = join(dir, 'app.db');
    // A DB migrated up to 0001 only: create it with the full set, then drop the newer tables and
    // their journal rows, as an older install would look.
    const first = new DbService(path);
    first.onModuleDestroy();
    const raw = new Database(path);
    raw.exec('DROP TABLE stream_cache; DROP TABLE settings; DROP TABLE last_source');
    raw
      .prepare(
        'DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 4)',
      )
      .run();
    raw.close();
    const upgraded = new DbService(path);
    const store2 = new StreamsCacheStore(upgraded);
    store2.put('movie:tt1', { results: [], errors: [] });
    expect(store2.stats().entries).toBe(1);
    upgraded.onModuleDestroy();
  });
});
