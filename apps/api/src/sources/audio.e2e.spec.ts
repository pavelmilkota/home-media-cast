import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudioProbeResponse, StreamsResponse } from '@home-media-cast/shared';
import { DbService } from '../db/db.service.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { mkv } from './testing/media-fixtures.js';

const SECRET = 'PROVIDER-SECRET-KEY';
const ENV = [
  'AIOSTREAMS_URL',
  'AIOSTREAMS_UUID',
  'AIOSTREAMS_PASSWORD',
  'PLAYBACK_ALLOW_HOSTS',
] as const;
const hash = (n: number) => String(n).repeat(40).slice(0, 40);

const FILE = mkv([
  { type: 1, codec: 'V_MPEG4/ISO/AVC' },
  { type: 2, codec: 'A_AC3', lang: 'ukr', channels: 6 },
  { type: 2, codec: 'A_AAC', lang: 'eng', channels: 2 },
]);

describe('audio probe (e2e)', () => {
  let t: TestApp;
  let token: string;
  let aio: Server;
  let provider: Server;
  let providerPort: number;
  /** Paths the provider was asked for, with the Range header. */
  let hits: { path: string; range?: string }[];
  let ignoreRange = false;
  const saved: Record<string, string | undefined> = {};

  const url = (name: string) => `http://127.0.0.1:${providerPort}/${name}?token=${SECRET}`;
  const results = () => [
    // Listed as English only; the file really has Ukrainian and English.
    {
      url: url('cached.mkv'),
      infoHash: hash(1),
      filename: 'Cached.mkv',
      languages: ['English'],
      service: 'torbox',
      cached: true,
    },
    { url: url('uncached.mkv'), infoHash: hash(2), filename: 'Uncached.mkv', cached: false },
    // A debrid result that does not say whether it is cached: could start a download.
    { url: url('unknown.mkv'), infoHash: hash(3), filename: 'Unknown.mkv', service: 'torbox' },
    // Not a torrent we can name: nothing to cache the answer under.
    { url: url('nohash.mkv'), filename: 'NoHash.mkv', cached: true },
    // No flag and no service: not known to be cached, so never opened either.
    { url: url('noflag.mkv'), infoHash: hash(5), filename: 'NoFlag.mkv' },
    { url: url('nullflag.mkv'), infoHash: hash(6), filename: 'NullFlag.mkv', cached: null },
    {
      url: url('nullsvc.mkv'),
      infoHash: hash(7),
      filename: 'NullSvc.mkv',
      service: 'torbox',
      cached: null,
    },
    { url: url('avi.avi'), infoHash: hash(4), filename: 'Old.avi', cached: true },
  ];

  const start = async (db?: DbService) => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env['AIOSTREAMS_URL'] = `http://127.0.0.1:${(aio.address() as AddressInfo).port}`;
    process.env['AIOSTREAMS_UUID'] = 'uuid-1';
    process.env['AIOSTREAMS_PASSWORD'] = 'pw-1';
    t = await createTestApp(() => undefined, db ? { db } : {});
    token = await pairDevice(t);
  };

  beforeEach(async () => {
    hits = [];
    ignoreRange = false;
    aio = createServer((_req, res) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, data: { results: results(), errors: [] } })),
    );
    provider = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      hits.push({ path: u.pathname, ...(range ? { range } : {}) });
      if (u.searchParams.get('token') !== SECRET) return void res.writeHead(403).end();
      const body = u.pathname === '/avi.avi' ? Buffer.from('RIFF0000AVI LIST') : FILE;
      const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (!m || ignoreRange) {
        return void res
          .writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': body.length })
          .end(body);
      }
      const from = Number(m[1]);
      const to = Math.min(Number(m[2]), body.length - 1);
      if (from >= body.length) return void res.writeHead(416).end();
      res
        .writeHead(206, {
          'content-type': 'video/x-matroska',
          'content-range': `bytes ${from}-${to}/${body.length}`,
          'content-length': to - from + 1,
        })
        .end(body.subarray(from, to + 1));
    });
    await Promise.all(
      [aio, provider].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))),
    );
    providerPort = (provider.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await t?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const s of [aio, provider]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });

  const list = async () =>
    ((await t.http('GET', '/titles/movie/tt0111161/streams', { token })).body as StreamsResponse)
      .options;
  const audio = (id: string) => t.http('GET', `/streams/options/${id}/audio`, { token });
  const byTitle = (options: Awaited<ReturnType<typeof list>>, title: string) =>
    options.find((o) => o.title === title)!;

  it('needs a token', async () => {
    await start();
    expect((await t.http('GET', '/streams/options/x/audio')).status).toBe(401);
  });

  it('reads the real tracks, then lists them without touching the provider again', async () => {
    await start();
    const cached = byTitle(await list(), 'Cached.mkv');
    expect(cached).toMatchObject({ languages: ['English'] });
    expect(cached.audioVerified).toBeUndefined();

    const res = await audio(cached.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      tracks: [
        { language: 'Ukrainian', codec: 'AC3', channels: 6 },
        { language: 'English', codec: 'AAC', channels: 2 },
      ],
      languages: ['Ukrainian', 'English'],
    } satisfies AudioProbeResponse);
    // Header reads only, as ranges, with the provider's own token.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.range?.startsWith('bytes='))).toBe(true);

    const before = hits.length;
    expect(await audio(cached.id)).toMatchObject({ status: 200, body: { status: 'ok' } });
    const again = byTitle(await list(), 'Cached.mkv');
    expect(again).toMatchObject({ languages: ['Ukrainian', 'English'], audioVerified: true });
    expect(hits.length).toBe(before);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(again)).not.toContain('127.0.0.1');
  });

  it('keeps the answer across an API restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hmc-audio-')), 'app.db');
    const db = new DbService(file);
    await start(db);
    await audio(byTitle(await list(), 'Cached.mkv').id);
    await t.close();
    const reopened = new DbService(file);
    await start(reopened);
    hits = [];
    expect(byTitle(await list(), 'Cached.mkv')).toMatchObject({ audioVerified: true });
    expect(hits).toHaveLength(0);
  });

  it('never opens a link that could start a download, or one it cannot name', async () => {
    await start();
    const options = await list();
    for (const title of [
      'Uncached.mkv',
      'Unknown.mkv',
      'NoHash.mkv',
      'NoFlag.mkv',
      'NullFlag.mkv',
      'NullSvc.mkv',
    ]) {
      expect((await audio(byTitle(options, title).id)).body).toEqual({ status: 'unavailable' });
    }
    expect(hits).toHaveLength(0);
    // The one cached row still reads.
    expect((await audio(byTitle(options, 'Cached.mkv').id)).body).toMatchObject({ status: 'ok' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.path === '/cached.mkv')).toBe(true);
  });

  it('answers "unavailable" for a container it cannot read, and does not try it again', async () => {
    await start();
    const avi = byTitle(await list(), 'Old.avi');
    expect((await audio(avi.id)).body).toEqual({ status: 'unavailable' });
    const before = hits.length;
    expect((await audio(avi.id)).body).toEqual({ status: 'unavailable' });
    expect(hits.length).toBe(before);
  });

  it('reads the start of the file from a server that ignores Range', async () => {
    ignoreRange = true;
    await start();
    // The first block can be read from a plain 200; later ones are refused (the answer is cut).
    const res = await audio(byTitle(await list(), 'Cached.mkv').id);
    expect(res.status).toBe(200);
  });

  it('answers "unavailable", not an error, when the provider refuses the link', async () => {
    await start();
    const cached = byTitle(await list(), 'Cached.mkv');
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    expect((await audio(cached.id)).body).toEqual({ status: 'unavailable' });
  });

  it('answers 410 for an unknown option id', async () => {
    await start();
    expect((await audio('nope')).status).toBe(410);
  });
});
