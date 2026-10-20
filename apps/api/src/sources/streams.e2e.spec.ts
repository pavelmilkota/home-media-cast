import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LibraryResponse, StreamsResponse } from '@home-media-cast/shared';
import { LibraryService } from '../catalog/library.service.js';
import { DbService } from '../db/db.service.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

const SECRET = 'PROVIDER-SECRET-KEY';
const HASH = 'dace3fb370fc9567447fd9b1f19fee787b4d3f17';
const VIDEO = Buffer.from('fake-video-bytes');
const ENV = [
  'AIOSTREAMS_URL',
  'AIOSTREAMS_UUID',
  'AIOSTREAMS_PASSWORD',
  'PLAYBACK_ALLOW_HOSTS',
] as const;

describe('streams (e2e)', () => {
  let t: TestApp;
  let token: string;
  let aio: Server;
  let provider: Server;
  let providerPort: number;
  let aioReply: (res: import('node:http').ServerResponse) => void;
  let aioRequests: number;
  const saved: Record<string, string | undefined> = {};

  const start = async (
    configured = true,
    extraSetup: (kodi: Parameters<Parameters<typeof createTestApp>[0] & {}>[0]) => void = () =>
      undefined,
    db?: DbService,
  ) => {
    for (const k of ENV) saved[k] = process.env[k];
    if (configured) {
      process.env['AIOSTREAMS_URL'] = `http://127.0.0.1:${(aio.address() as AddressInfo).port}`;
      process.env['AIOSTREAMS_UUID'] = 'uuid-1';
      process.env['AIOSTREAMS_PASSWORD'] = 'pw-1';
    } else {
      for (const k of ENV) delete process.env[k];
    }
    t = await createTestApp(
      (kodi) => {
        kodi.on('Player.Open', 'OK');
        extraSetup(kodi);
      },
      db ? { db } : {},
    );
    token = await pairDevice(t);
  };

  const results = () => [
    {
      url: `http://127.0.0.1:${providerPort}/dl?token=${SECRET}`,
      infoHash: HASH,
      filename: 'Uncached.1080p.mkv',
      languages: ['Ukrainian', 'English', 'English', ''],
      resolution: '1080p',
      service: 'torbox',
      cached: false,
      size: 9e9,
    },
    {
      url: `http://127.0.0.1:${providerPort}/dl?token=${SECRET}`,
      infoHash: HASH,
      filename: 'Cached.720p.mkv',
      parsedFile: { languages: ['English'], resolution: '720p' },
      service: 'torbox',
      cached: true,
      size: 1e9,
    },
    {
      url: `http://127.0.0.1:${providerPort}/dl?token=${SECRET}`,
      infoHash: HASH,
      filename: 'Cached.1080p.mkv',
      service: 'realdebrid',
      cached: true,
      size: 3e9,
    },
    { ytId: 'jNQXAC9IVRw', filename: 'Trailer' },
    { nzbUrl: 'https://h/x.nzb', filename: 'Usenet' },
    { infoHash: HASH, filename: 'Torrent only', cached: true },
  ];

  beforeEach(async () => {
    aioRequests = 0;
    aioReply = (res) =>
      void res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          data: { results: results(), errors: [{ title: '[❌] AIOSubtitle' }] },
        }),
      );
    aio = createServer((_req, res) => {
      aioRequests++;
      aioReply(res);
    });
    provider = createServer((req, res) => {
      const ok = new URL(req.url ?? '/', 'http://x').searchParams.get('token') === SECRET;
      res
        .writeHead(ok ? 200 : 403, {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO.length),
        })
        .end(ok ? VIDEO : '');
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

  const list = () => t.http('GET', '/titles/series/tt7049682:1:4/streams', { token });
  const play = (optionId: string) =>
    t.http('POST', '/playback/stream', { token, body: { optionId } });
  const optionsOf = async () => ((await list()).body as StreamsResponse).options;

  it('needs a token', async () => {
    await start();
    expect((await t.http('GET', '/titles/movie/tt0111161/streams')).status).toBe(401);
    expect((await t.http('POST', '/playback/stream', { body: { optionId: 'x' } })).status).toBe(
      401,
    );
    expect(aioRequests).toBe(0);
  });

  it('lists options in AIOStreams order (playable first), no URL, hash or key anywhere, source errors included', async () => {
    await start();
    const res = await list();
    expect(res.status).toBe(200);
    const body = res.body as StreamsResponse;
    expect(body.sourceErrors).toEqual(['[❌] AIOSubtitle']);
    expect(body.options.map((o) => o.title)).toEqual([
      // The order AIOStreams returned (its own sort settings), not re-sorted by us...
      'Uncached.1080p.mkv',
      'Cached.720p.mkv',
      'Cached.1080p.mkv',
      'Trailer',
      // ...except that what cannot be played goes last, in its original order.
      'Usenet',
      'Torrent only',
    ]);
    expect(body.options[0]).toMatchObject({
      languages: ['Ukrainian', 'English'],
      resolution: '1080p',
    });
    expect(body.options[1]).toMatchObject({ languages: ['English'], resolution: '720p' });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(HASH);
    expect(json).not.toContain('127.0.0.1');
    expect(json).not.toContain('http');
    expect(body.options.find((o) => o.title === 'Usenet')).toMatchObject({
      playable: false,
      reason: 'Unsupported source type (nzbUrl)',
    });
  });

  it('plays an option through the relay: Kodi gets a loopback URL, never the provider URL', async () => {
    await start();
    const cached = (await optionsOf()).find((o) => o.title === 'Cached.1080p.mkv')!;
    const res = await play(cached.id);
    expect(res).toEqual({ status: 202, body: { status: 'accepted' } });

    const open = t.kodi.requests.filter((r) => r.method === 'Player.Open');
    expect(open).toHaveLength(1);
    const file = (open[0]?.params as { item: { file: string } }).item.file;
    expect(file).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/relay\/[A-Za-z0-9_-]{22}\/Cached\.1080p\.mkv$/,
    );
    expect(file).not.toContain(SECRET);
    expect(file).not.toContain(`:${providerPort}`);

    // Kodi would now fetch the relay URL; the relay streams the provider's bytes.
    const relayed = await fetch(`${t.base}${new URL(file).pathname.replace('/api', '')}`);
    expect(relayed.status).toBe(200);
    expect(Buffer.from(await relayed.arrayBuffer()).equals(VIDEO)).toBe(true);
    expect(t.logLines.join('\n')).not.toContain(SECRET);
  });

  it('tells the phone at once when the source link is dead, and never opens it in Kodi', async () => {
    await start();
    const cached = (await optionsOf()).find((o) => o.title === 'Cached.1080p.mkv')!;
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    const res = await play(cached.id);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'stream_unreachable' });
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|token|PROVIDER-SECRET/);
    expect(t.kodi.requests.filter((r) => r.method === 'Player.Open')).toHaveLength(0);
  });

  it('reports a refused link as expired', async () => {
    await start();
    const cached = (await optionsOf()).find((o) => o.title === 'Cached.1080p.mkv')!;
    provider.removeAllListeners('request');
    provider.on('request', (_req, res) => void res.writeHead(403).end());
    const res = await play(cached.id);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'stream_expired' });
  });

  /** Replaces the provider's answer with one that counts its requests and can fail the first ones. */
  const flakyProvider = (failFirst: number) => {
    const seen = { count: 0 };
    provider.removeAllListeners('request');
    provider.on('request', (_req, res) => {
      seen.count++;
      const ok = seen.count > failFirst;
      res
        .writeHead(ok ? 200 : 403, {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO.length),
        })
        .end(ok ? VIDEO : '');
    });
    return seen;
  };

  it('asks for a fresh link once when the first one is refused, then plays', async () => {
    await start();
    const cached = (await optionsOf()).find((o) => o.title === 'Cached.1080p.mkv')!;
    const seen = flakyProvider(1);
    const res = await play(cached.id);
    expect(res.status).toBe(202);
    expect(seen.count).toBe(2);
    expect(t.kodi.requests.filter((r) => r.method === 'Player.Open')).toHaveLength(1);
  });

  it('gives up after exactly two attempts and never opens a dead link in Kodi', async () => {
    await start();
    const cached = (await optionsOf()).find((o) => o.title === 'Cached.1080p.mkv')!;
    const seen = flakyProvider(99);
    const res = await play(cached.id);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'stream_expired' });
    expect(seen.count).toBe(2);
    expect(t.kodi.requests.filter((r) => r.method === 'Player.Open')).toHaveLength(0);
  });

  it('does not retry a source that cannot be played', async () => {
    await start();
    const usenet = (await optionsOf()).find((o) => o.title === 'Usenet')!;
    const seen = flakyProvider(0);
    expect((await play(usenet.id)).status).toBe(422);
    expect(seen.count).toBe(0);
  });

  describe('last selected source', () => {
    const HASH_B = 'beef0000beef0000beef0000beef0000beef0000';
    const KEY = JSON.stringify({ r: '', l: [], h: HASH_B });
    const answer = () => {
      const r = (filename: string, infoHash: string) => ({
        url: `http://127.0.0.1:${providerPort}/dl?token=${SECRET}`,
        infoHash,
        filename,
        cached: true,
      });
      aioReply = (res) =>
        void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            success: true,
            data: {
              results: [r('A.mkv', HASH), r('B.mkv', HASH_B), r('C.mkv', HASH)],
              errors: [],
            },
          }),
        );
    };
    const played = (db: DbService, videoId: string, releaseKey?: string) => {
      if (releaseKey) new LibraryService(db).rememberRelease(videoId, releaseKey);
    };

    it('lists the release played before first, flagged, and leaves the others in order', async () => {
      answer();
      const db = new DbService(':memory:');
      played(db, 'tt7049682:1:4', KEY);
      await start(true, undefined, db);
      const body = (await list()).body as StreamsResponse;
      expect(body.options.map((o) => o.title)).toEqual(['B.mkv', 'A.mkv', 'C.mkv']);
      expect(body.options.filter((o) => o.lastUsed)).toHaveLength(1);
      expect(body.options[0]?.lastUsed).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/beef0000|dace3fb3|token|SECRET/);
      // The flag is per request: the minted ids still play, and the order is not stored.
      expect((await play(body.options[0]!.id)).status).toBe(202);
    });

    it('changes nothing for another episode, without a stored release, or when nothing matches', async () => {
      answer();
      const db = new DbService(':memory:');
      played(db, 'tt7049682:1:3', KEY); // a different episode
      played(db, 'tt7049682:1:5'); // played from a pasted link: no release
      played(db, 'tt7049682:1:6', JSON.stringify({ r: '', l: [], h: 'f'.repeat(40) })); // gone
      await start(true, undefined, db);
      for (const ep of ['1:4', '1:5', '1:6']) {
        const res = await t.http('GET', `/titles/series/tt7049682:${ep}/streams`, { token });
        const body = res.body as StreamsResponse;
        expect(body.options.map((o) => o.title)).toEqual(['A.mkv', 'B.mkv', 'C.mkv']);
        expect(body.options.some((o) => o.lastUsed)).toBe(false);
      }
    });
  });

  it('records watch progress for a play that names its catalog title', async () => {
    const meta = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            meta: {
              id: 'tt7049682',
              name: 'Some Show',
              videos: [{ id: 'tt7049682:1:4', season: 1, number: 4, name: 'Four' }],
            },
          }),
        ),
    );
    await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
    const savedMeta = process.env['CINEMETA_URL'];
    process.env['CINEMETA_URL'] = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
    let started = false;
    const time = (s: number) => ({ hours: 0, minutes: 0, seconds: s, milliseconds: 0 });
    try {
      await start(true, (kodi) => {
        kodi
          .on('Application.GetProperties', { volume: 40, muted: false })
          .onCall('Player.GetActivePlayers', () =>
            started ? [{ playerid: 1, playertype: 'internal', type: 'video' }] : [],
          )
          .onCall('Player.GetProperties', () => ({
            speed: 1,
            time: time(600),
            totaltime: time(3000),
            audiostreams: [],
            currentaudiostream: null,
            subtitles: [],
            currentsubtitle: null,
            subtitleenabled: false,
          }))
          .on('Player.GetItem', { item: { label: 'Cached.1080p.mkv', type: 'unknown' } });
      });
      const cached = (await optionsOf()).find((o) => o.title === 'Cached.1080p.mkv')!;
      const res = await t.http('POST', '/playback/stream', {
        token,
        body: { optionId: cached.id, title: { type: 'series', id: 'tt7049682:1:4' } },
      });
      expect(res.status).toBe(202);
      started = true;
      // The phone is not listening: the backend alone must notice the TV started and stopped.
      t.kodi.notify('Player.OnPlay', {});
      await new Promise((r) => setTimeout(r, 400));
      started = false;
      t.kodi.notify('Player.OnStop', {});
      let lib: LibraryResponse | undefined;
      for (let i = 0; i < 50 && !lib?.history.length; i++) {
        await new Promise((r) => setTimeout(r, 40));
        lib = (await t.http('GET', '/library', { token })).body as LibraryResponse;
      }
      expect(lib?.history[0]).toMatchObject({
        id: 'tt7049682',
        videoId: 'tt7049682:1:4',
        label: 'S1E4 · Four',
        watched: false,
      });
      expect(lib?.continueWatching).toHaveLength(1);

      // Playing it again picks up where it stopped (10 minutes in); `resume: false` does not.
      const seeks = () => t.kodi.requests.filter((r) => r.method === 'Player.Seek');
      const again = (resume?: boolean) =>
        t.http('POST', '/playback/stream', {
          token,
          body: {
            optionId: cached.id,
            title: { type: 'series', id: 'tt7049682:1:4' },
            ...(resume === undefined ? {} : { resume }),
          },
        });
      expect(seeks()).toHaveLength(0);
      expect((await again(false)).status).toBe(202);
      started = true;
      t.kodi.notify('Player.OnPlay', {});
      await new Promise((r) => setTimeout(r, 300));
      expect(seeks()).toHaveLength(0);
      started = false;
      t.kodi.notify('Player.OnStop', {});
      await new Promise((r) => setTimeout(r, 300));

      expect((await again()).status).toBe(202);
      started = true;
      t.kodi.notify('Player.OnPlay', {});
      for (let i = 0; i < 50 && !seeks().length; i++) await new Promise((r) => setTimeout(r, 40));
      expect(seeks()[0]?.params).toMatchObject({
        value: { time: { hours: 0, minutes: 10, seconds: 0 } },
      });
    } finally {
      if (savedMeta === undefined) delete process.env['CINEMETA_URL'];
      else process.env['CINEMETA_URL'] = savedMeta;
      meta.closeAllConnections();
      await new Promise((r) => meta.close(r));
    }
  });

  it('plays a YouTube option through the addon', async () => {
    await start();
    const yt = (await optionsOf()).find((o) => o.kind === 'youtube')!;
    expect((await play(yt.id)).status).toBe(202);
    expect(t.kodi.requests.findLast((r) => r.method === 'Player.Open')?.params).toEqual({
      item: { file: 'plugin://plugin.video.youtube/play/?video_id=jNQXAC9IVRw' },
    });
  });

  it.each(['Usenet', 'Torrent only'])(
    'refuses %s with 422 and sends nothing to Kodi',
    async (title) => {
      await start();
      const o = (await optionsOf()).find((x) => x.title === title)!;
      expect((await play(o.id)).status).toBe(422);
      expect(t.kodi.requests.filter((r) => r.method === 'Player.Open')).toHaveLength(0);
    },
  );

  it('answers 410 for an unknown option id', async () => {
    await start();
    expect((await play('does-not-exist')).status).toBe(410);
  });

  it('answers 400 for a bad type or title id, without asking AIOStreams', async () => {
    await start();
    for (const path of [
      '/titles/book/tt1/streams',
      '/titles/movie/tt1:1:4/streams',
      '/titles/series/tt1/streams',
      '/titles/movie/x/streams',
    ]) {
      expect((await t.http('GET', path, { token })).status).toBe(400);
    }
    expect(aioRequests).toBe(0);
  });

  it('answers 503 "unavailable" when AIOStreams is down, and everything else keeps working', async () => {
    await start();
    await new Promise((r) => (aio.closeAllConnections(), aio.close(r)));
    const res = await list();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'source_unavailable' });
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|uuid-1|pw-1/);
    expect((await t.http('GET', '/youtube/cast', { token })).status).toBe(200);
  });

  it('answers 503 "unavailable" for refused credentials, not the owner’s secrets', async () => {
    await start();
    aioReply = (res) => void res.writeHead(401).end();
    const res = await list();
    expect(res.body).toMatchObject({ error: 'source_unavailable' });
  });

  it('answers 503 "not configured" when AIOStreams is not set up', async () => {
    await start(false);
    const res = await list();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'source_not_configured' });
  });

  describe('cache', () => {
    const waitFor = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 20));
    };
    const listBody = async (path = '/titles/series/tt7049682:1:4/streams') =>
      (await t.http('GET', path, { token })).body as StreamsResponse;

    it('serves the second open from the cache without asking AIOStreams again, with the same ids', async () => {
      await start();
      const first = await listBody();
      expect(first).toMatchObject({ refreshing: false });
      expect(typeof first.fetchedAt).toBe('number');
      const second = await listBody();
      expect(aioRequests).toBe(1);
      expect(second.options.map((o) => o.id)).toEqual(first.options.map((o) => o.id));
    });

    it('?refresh=1 starts an update inside the debounce window; polling then swaps the list', async () => {
      await start();
      const first = await listBody();
      const held: import('node:http').ServerResponse[] = [];
      const reply = aioReply;
      aioReply = (res) => void held.push(res);
      const forced = await listBody('/titles/series/tt7049682:1:4/streams?refresh=1');
      expect(forced.refreshing).toBe(true);
      await waitFor(async () => aioRequests >= 2);
      expect(aioRequests).toBe(2);
      // Polling while it runs does not search again.
      expect((await listBody()).refreshing).toBe(true);
      expect(aioRequests).toBe(2);
      await waitFor(async () => held.length > 0);
      reply(held[0]!);
      await waitFor(async () => !(await listBody()).refreshing);
      const fresh = await listBody();
      expect(fresh.refreshing).toBe(false);
      expect(fresh.options.map((o) => o.id)).not.toEqual(first.options.map((o) => o.id));
      // An id from before the swap still plays.
      const old = first.options.find((o) => o.title === 'Cached.1080p.mkv')!;
      expect((await play(old.id)).status).toBe(202);
    });

    it('keeps the cached list and reports refreshError when the update fails', async () => {
      await start();
      await listBody();
      aioReply = (res) => void res.writeHead(500).end();
      expect((await listBody('/titles/series/tt7049682:1:4/streams?refresh=1')).refreshing).toBe(
        true,
      );
      await waitFor(async () => !(await listBody()).refreshing);
      const res = await listBody();
      expect(res.options.length).toBeGreaterThan(0);
      expect(res.refreshError).toBe('AIOStreams is not reachable');
      expect(JSON.stringify(res)).not.toMatch(/127\.0\.0\.1|uuid-1|pw-1|token|SECRET/);
    });

    it('survives an API restart: the new app answers from the same DB file, then updates', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'hmc-streams-')), 'app.sqlite');
      await start(true, undefined, new DbService(path));
      const first = await listBody();
      await t.close();

      aioReply = () => undefined; // the update hangs: only the cache can answer
      await start(true, undefined, new DbService(path));
      const warm = await listBody();
      await waitFor(async () => aioRequests >= 2);
      expect(aioRequests).toBe(2);
      expect(warm).toMatchObject({ refreshing: true, fetchedAt: first.fetchedAt });
      expect(warm.options.map((o) => o.title)).toEqual(first.options.map((o) => o.title));
      expect(JSON.stringify(warm)).not.toContain(SECRET);
      // And its ids play.
      expect(
        (await play(warm.options.find((o) => o.title === 'Cached.1080p.mkv')!.id)).status,
      ).toBe(202);
    });
    it('reports and clears the cache; the next open searches again, and a playing id still works', async () => {
      await start();
      expect((await t.http('GET', '/streams/cache')).status).toBe(401);
      expect((await t.http('DELETE', '/streams/cache')).status).toBe(401);
      expect((await t.http('GET', '/streams/cache', { token })).body).toEqual({ entries: 0 });
      const first = await listBody();
      const stats = (await t.http('GET', '/streams/cache', { token })).body as {
        entries: number;
        oldestFetchedAt: number;
      };
      expect(stats).toEqual({ entries: 1, oldestFetchedAt: first.fetchedAt });
      expect(JSON.stringify(stats)).not.toContain(SECRET);

      const cleared = await t.http('DELETE', '/streams/cache', { token });
      expect(cleared).toEqual({ status: 200, body: { cleared: 1 } });
      expect(JSON.stringify(cleared.body)).not.toContain(SECRET);
      expect((await t.http('GET', '/streams/cache', { token })).body).toEqual({ entries: 0 });

      const again = await listBody();
      expect(again.refreshing).toBe(false);
      expect(aioRequests).toBe(2);
      // An id handed out before the clear still plays.
      const old = first.options.find((o) => o.title === 'Cached.1080p.mkv')!;
      expect((await play(old.id)).status).toBe(202);
    });
  });
});
