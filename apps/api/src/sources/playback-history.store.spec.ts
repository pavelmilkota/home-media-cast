import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbService } from '../db/db.service.js';
import { playbackHistory } from '../db/schema.js';
import {
  MAX_AGE_MS,
  MAX_ROWS,
  PlaybackHistoryStore,
  type HistoryEntry,
} from './playback-history.store.js';

const entry = (id: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  type: 'movie',
  titleId: id.split(':')[0]!,
  name: `Title ${id}`,
  releaseTitle: `Release.${id}.1080p`,
  releaseKey: JSON.stringify({ infoHash: id }),
  ...extra,
});

describe('PlaybackHistoryStore', () => {
  let db: DbService;
  let store: PlaybackHistoryStore;

  beforeEach(() => {
    db = new DbService(':memory:');
    store = new PlaybackHistoryStore(db);
  });
  afterEach(() => db.onModuleDestroy());

  it('creates the table by migration on a fresh database', () => {
    expect(store.list()).toEqual([]);
  });

  it('round-trips optional fields', () => {
    store.record(
      entry('tt1:2:3', {
        type: 'series',
        year: '2020',
        poster: 'https://img/p.jpg',
        label: 'S02E03 · Pilot',
        resolution: '1080p',
        quality: 'WEB-DL',
      }),
      1000,
    );
    expect(store.get('tt1:2:3', 1000)).toEqual({
      ...entry('tt1:2:3', {
        type: 'series',
        year: '2020',
        poster: 'https://img/p.jpg',
        label: 'S02E03 · Pilot',
        resolution: '1080p',
        quality: 'WEB-DL',
      }),
      playedAt: 1000,
    });
  });

  it('orders newest first', () => {
    store.record(entry('tt1'), 1000);
    store.record(entry('tt2'), 3000);
    store.record(entry('tt3'), 2000);
    expect(store.list(4000).map((e) => e.id)).toEqual(['tt2', 'tt3', 'tt1']);
  });

  it('refreshes the row of the same video instead of duplicating it', () => {
    store.record(entry('tt1', { releaseTitle: 'old' }), 1000);
    store.record(entry('tt2'), 2000);
    store.record(entry('tt1', { releaseTitle: 'new' }), 3000);
    const items = store.list(4000);
    expect(items.map((e) => e.id)).toEqual(['tt1', 'tt2']);
    expect(items[0]).toMatchObject({ releaseTitle: 'new', playedAt: 3000 });
  });

  it('clears optional fields that a refresh leaves out', () => {
    store.record(entry('tt1', { quality: 'BluRay' }), 1000);
    store.record(entry('tt1'), 2000);
    expect(store.get('tt1', 2000)?.quality).toBeUndefined();
  });

  it('keeps only the newest five', () => {
    for (let i = 1; i <= 7; i++) store.record(entry(`tt${i}`), i * 1000);
    expect(store.list(8000).map((e) => e.id)).toEqual(['tt7', 'tt6', 'tt5', 'tt4', 'tt3']);
    expect(db.orm.select().from(playbackHistory).all()).toHaveLength(MAX_ROWS);
  });

  it('keeps a row of exactly 24 h and drops one older', () => {
    const now = 100 * MAX_AGE_MS;
    store.record(entry('tt1'), now - MAX_AGE_MS);
    store.record(entry('tt2'), now - MAX_AGE_MS - 1);
    expect(store.list(now).map((e) => e.id)).toEqual(['tt1']);
    expect(store.get('tt1', now)).toBeDefined();
    expect(store.get('tt2', now)).toBeUndefined();
  });

  it('prunes expired rows when recording', () => {
    const now = 100 * MAX_AGE_MS;
    store.record(entry('tt1'), now - 2 * MAX_AGE_MS);
    store.record(entry('tt2'), now);
    expect(db.orm.select().from(playbackHistory).all()).toHaveLength(1);
  });

  it('misses an unknown id', () => {
    expect(store.get('nope')).toBeUndefined();
  });
});
