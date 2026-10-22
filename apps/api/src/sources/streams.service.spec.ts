import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceUnavailableError, type AioStreamsClient } from '../aiostreams/aiostreams.client.js';
import { DbService } from '../db/db.service.js';
import { AudioProbeStore } from './audio-probe.store.js';
import { StreamsCacheStore } from './streams-cache.store.js';
import { StreamsService } from './streams.service.js';
import { mkv } from './testing/media-fixtures.js';

const raw = (name: string) => ({
  url: `http://127.0.0.1:1/dl?token=SECRET`,
  infoHash: 'dace3fb370fc9567447fd9b1f19fee787b4d3f17',
  filename: name,
  cached: true,
});

describe('StreamsService cache', () => {
  let db: DbService;
  let store: StreamsCacheStore;
  let clock: number;
  let search: ReturnType<typeof vi.fn>;
  let service: StreamsService;

  const make = () =>
    new StreamsService({ search } as unknown as AioStreamsClient, {} as never, {} as never, store, {
      now: () => clock,
    });
  /** Lets background promises settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    clock = 1_000_000;
    db = new DbService(':memory:');
    store = new StreamsCacheStore(db);
    search = vi.fn(async () => ({ results: [raw('A.mkv')], errors: [] }));
    service = make();
  });
  afterEach(() => db.onModuleDestroy());

  it('awaits the search on a miss and reports a settled list', async () => {
    const res = await service.list('movie', 'tt0111161');
    expect(search).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ fetchedAt: clock, refreshing: false });
    expect(res.refreshError).toBeUndefined();
    expect(res.options.map((o) => o.title)).toEqual(['A.mkv']);
  });

  it('does not search again inside the debounce window, and keeps ids stable', async () => {
    const first = await service.list('movie', 'tt0111161');
    clock += 14_000;
    const second = await service.list('movie', 'tt0111161');
    expect(search).toHaveBeenCalledTimes(1);
    expect(second.options.map((o) => o.id)).toEqual(first.options.map((o) => o.id));
  });

  it('serves the cache at once after the window and swaps the list when the update lands', async () => {
    const first = await service.list('movie', 'tt0111161');
    clock += 16_000;
    let release!: () => void;
    search.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ results: [raw('B.mkv')], errors: [] });
        }),
    );
    const stale = await service.list('movie', 'tt0111161');
    expect(stale).toMatchObject({ refreshing: true, fetchedAt: first.fetchedAt });
    expect(stale.options.map((o) => o.title)).toEqual(['A.mkv']);
    // A poll while it runs neither searches again nor changes ids.
    expect((await service.list('movie', 'tt0111161')).options[0]?.id).toBe(stale.options[0]?.id);
    expect(search).toHaveBeenCalledTimes(2);
    release();
    await settle();
    const fresh = await service.list('movie', 'tt0111161');
    expect(fresh).toMatchObject({ refreshing: false, fetchedAt: clock });
    expect(fresh.options.map((o) => o.title)).toEqual(['B.mkv']);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('forces an update with refresh, even inside the window', async () => {
    await service.list('movie', 'tt0111161');
    const res = await service.list('movie', 'tt0111161', { refresh: true });
    expect(res.refreshing).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent cold requests into one search with one set of ids', async () => {
    const [a, b] = await Promise.all([
      service.list('movie', 'tt0111161'),
      service.list('movie', 'tt0111161'),
    ]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(a.options[0]?.id).toBe(b.options[0]?.id);
  });

  it('keeps the cached list when an update fails, and does not retry on the next poll', async () => {
    await service.list('movie', 'tt0111161');
    clock += 16_000;
    search.mockRejectedValueOnce(new SourceUnavailableError('down at http://secret-host'));
    await service.list('movie', 'tt0111161');
    await settle();
    clock += 1_000;
    const res = await service.list('movie', 'tt0111161');
    expect(res).toMatchObject({
      refreshing: false,
      refreshError: 'AIOStreams is not reachable',
    });
    expect(res.options.map((o) => o.title)).toEqual(['A.mkv']);
    expect(search).toHaveBeenCalledTimes(2);
    // A later successful update clears the error.
    clock += 16_000;
    await service.list('movie', 'tt0111161');
    await settle();
    expect((await service.list('movie', 'tt0111161')).refreshError).toBeUndefined();
  });

  it('throws the search error on a miss when nothing is cached', async () => {
    search.mockRejectedValueOnce(new SourceUnavailableError('down'));
    await expect(service.list('movie', 'tt0111161')).rejects.toBeInstanceOf(SourceUnavailableError);
    expect(store.stats().entries).toBe(0);
  });

  it('serves from SQLite after a restart (a new service on the same DB)', async () => {
    await service.list('movie', 'tt0111161');
    service = make();
    clock += 1_000;
    const res = await service.list('movie', 'tt0111161');
    expect(res).toMatchObject({ refreshing: true });
    expect(res.options.map((o) => o.title)).toEqual(['A.mkv']);
  });

  it('mints new ids after 20 minutes without losing the old ones', async () => {
    const first = await service.list('movie', 'tt0111161');
    clock += 21 * 60_000;
    const later = await service.list('movie', 'tt0111161');
    expect(later.options[0]?.id).not.toBe(first.options[0]?.id);
    expect(service.bingeGroupOf(first.options[0]!.id)).toBeDefined();
  });

  it('keeps a pre-swap id valid after the list is replaced', async () => {
    const first = await service.list('movie', 'tt0111161');
    clock += 16_000;
    await service.list('movie', 'tt0111161');
    await settle();
    expect(service.bingeGroupOf(first.options[0]!.id)).toBeDefined();
  });

  it('findMatching always searches live and never reads the cache', async () => {
    await service.list('movie', 'tt0111161');
    search.mockClear();
    await service.findMatching('movie', 'tt0111161', undefined);
    await service.findMatching('movie', 'tt0111161', undefined);
    expect(search).toHaveBeenCalledTimes(2);
    expect(store.get('movie:tt0111161')?.fetchedAt).toBe(1_000_000);
  });

  it('clearCache empties SQLite and memory, so the next list is a cold search', async () => {
    await service.list('movie', 'tt0111161');
    expect(service.cacheStats().entries).toBe(1);
    expect(service.clearCache()).toBe(1);
    expect(service.cacheStats()).toEqual({ entries: 0 });
    search.mockClear();
    const res = await service.list('movie', 'tt0111161');
    expect(search).toHaveBeenCalledTimes(1);
    expect(res.refreshing).toBe(false);
  });

  it('does not bring a list back when the cache is cleared during an update', async () => {
    await service.list('movie', 'tt0111161');
    clock += 16_000;
    let release!: () => void;
    search.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ results: [raw('B.mkv')], errors: [] });
        }),
    );
    await service.list('movie', 'tt0111161'); // starts the update
    service.clearCache();
    release();
    await settle();
    expect(service.cacheStats()).toEqual({ entries: 0 });
  });
});

describe('StreamsService audio probe gate', () => {
  const FILE = mkv([{ type: 2, codec: 'A_AAC', lang: 'ukr', channels: 2 }]);
  let db: DbService;
  let audio: AudioProbeStore;
  let readRange: ReturnType<typeof vi.fn>;

  const optionIds = async (results: unknown[]) => {
    const service = new StreamsService(
      { search: async () => ({ results, errors: [] }) } as unknown as AioStreamsClient,
      { readRange } as never,
      {} as never,
      new StreamsCacheStore(db),
      { audio },
    );
    const res = await service.list('movie', 'tt0111161');
    return { service, res };
  };
  const base = (n: number) => ({
    url: `http://127.0.0.1:1/${n}?token=SECRET`,
    infoHash: String(n).repeat(40).slice(0, 40),
    filename: `F${n}.mkv`,
  });

  beforeEach(() => {
    db = new DbService(':memory:');
    audio = new AudioProbeStore(db);
    readRange = vi.fn(async (_t: unknown, start: number, length: number) =>
      FILE.subarray(start, start + length),
    );
  });
  afterEach(() => db.onModuleDestroy());

  it('reads a cached row', async () => {
    const { service, res } = await optionIds([{ ...base(1), cached: true }]);
    const out = await service.probeAudio(res.options[0]!.id);
    expect(out.status).toBe('ok');
    expect(readRange).toHaveBeenCalled();
  });

  it('makes no request for cached:false, cached:null or a missing flag', async () => {
    const { service, res } = await optionIds([
      { ...base(2), cached: false },
      { ...base(3), cached: null },
      { ...base(4) },
      { ...base(5), service: 'torbox' },
    ]);
    for (const o of res.options) {
      expect(await service.probeAudio(o.id)).toEqual({ status: 'unavailable' });
    }
    expect(readRange).not.toHaveBeenCalled();
  });

  it('still returns tracks already stored for an uncached row', async () => {
    const { service, res } = await optionIds([{ ...base(6), cached: false }]);
    const first = await service.list('movie', 'tt0111161');
    expect(first.options[0]?.audioVerified).toBeUndefined();
    // Store tracks under the key the service derives for this row.
    const { audioKey, classifyResult } = await import('./stream-source.js');
    audio.put(audioKey(classifyResult({ ...base(6), cached: false })) as string, [
      { language: 'Ukrainian', codec: 'AAC' },
    ]);
    const out = await service.probeAudio(res.options[0]!.id);
    expect(out.status).toBe('ok');
    expect((await service.list('movie', 'tt0111161')).options[0]?.audioVerified).toBe(true);
    expect(readRange).not.toHaveBeenCalled();
  });
});
