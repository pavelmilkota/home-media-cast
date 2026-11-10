import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PlaybackHistoryResponse } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

const ENV = ['AIOSTREAMS_URL', 'AIOSTREAMS_UUID', 'AIOSTREAMS_PASSWORD', 'CINEMETA_URL'] as const;
const GROUP = 'secret-group|1080p';
const EP = 'tt7049682:1:4';

describe('playback history (e2e)', () => {
  let t: TestApp;
  let token: string;
  let servers: Server[];
  /** The releases AIOStreams offers; emptied to simulate "nothing from the same release". */
  let offered: { name: string; group: string; cached: boolean }[];
  const saved: Record<string, string | undefined> = {};

  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };

  const start = async (configured = true) => {
    servers = [];
    offered = [{ name: 'Show.S01E04.1080p.WEB-DL.mkv', group: GROUP, cached: true }];
    const provider = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4' }).end('data'),
    );
    const providerPort = await listen(provider);
    const aio = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            success: true,
            data: {
              results: offered.map((o) => ({
                url: `http://127.0.0.1:${providerPort}/dl?key=PROVIDER-KEY`,
                filename: o.name,
                service: 'torbox',
                cached: o.cached,
                bingeGroup: o.group,
              })),
              errors: [],
            },
          }),
        ),
    );
    const meta = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            meta: {
              id: 'tt7049682',
              name: 'Some Show',
              year: '2019',
              poster: 'https://img.example/p.jpg',
              videos: [{ id: 'x', season: 1, number: 4, name: 'Four', firstAired: '2020-01-01' }],
            },
          }),
        ),
    );
    const [aioPort, metaPort] = [await listen(aio), await listen(meta)];
    for (const k of ENV) saved[k] = process.env[k];
    if (configured) {
      process.env['AIOSTREAMS_URL'] = `http://127.0.0.1:${aioPort}`;
      process.env['AIOSTREAMS_UUID'] = 'u';
      process.env['AIOSTREAMS_PASSWORD'] = 'p';
    } else {
      for (const k of ['AIOSTREAMS_URL', 'AIOSTREAMS_UUID', 'AIOSTREAMS_PASSWORD'] as const) {
        delete process.env[k];
      }
    }
    process.env['CINEMETA_URL'] = `http://127.0.0.1:${metaPort}`;
    t = await createTestApp((kodi) =>
      kodi
        .on('Player.Open', 'OK')
        .on('Application.GetProperties', { volume: 40, muted: false })
        .on('Player.GetActivePlayers', [])
        .on('Player.GetItem', { item: { label: 'x.mkv', type: 'unknown' } }),
    );
    token = await pairDevice(t);
  };

  beforeEach(() => start());
  afterEach(async () => {
    await t?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });

  const http = (m: string, p: string, body?: unknown) => t.http(m, p, { token, body });
  const opens = () => t.kodi.requests.filter((r) => r.method === 'Player.Open');
  const history = async () =>
    (await http('GET', '/playback/history')).body as PlaybackHistoryResponse;

  const playFromList = async (type: 'movie' | 'series', id: string, pick?: string) => {
    const list = await http('GET', `/titles/${type}/${encodeURIComponent(id)}/streams`);
    const options = (list.body as { options: { id: string; title: string }[] }).options;
    const option = pick ? options.find((o) => o.title === pick)! : options[0]!;
    return http('POST', '/playback/stream', { optionId: option.id, title: { type, id } });
  };

  it('needs a token', async () => {
    expect((await t.http('GET', '/playback/history')).status).toBe(401);
    expect((await t.http('POST', '/playback/history/x/play')).status).toBe(401);
  });

  it('starts empty', async () => {
    expect(await history()).toEqual({ items: [] });
  });

  it('records an episode and a movie, newest first, without any secret', async () => {
    expect((await playFromList('series', EP)).status).toBe(202);
    expect((await playFromList('movie', 'tt0111161')).status).toBe(202);

    const res = await http('GET', '/playback/history');
    const { items } = res.body as PlaybackHistoryResponse;
    expect(items.map((i) => i.id)).toEqual(['tt0111161', EP]);
    expect(items[1]).toMatchObject({
      type: 'series',
      titleId: 'tt7049682',
      name: 'Some Show',
      year: '2019',
      poster: 'https://img.example/p.jpg',
      label: 'S1E4 · Four',
      releaseTitle: 'Show.S01E04.1080p.WEB-DL.mkv',
      resolution: '1080p',
    });

    const text = JSON.stringify(res.body) + t.logLines.join('\n');
    for (const secret of ['PROVIDER-KEY', '127.0.0.1', 'secret-group', 'optionId', 'releaseKey']) {
      expect(text).not.toContain(secret);
    }
  });

  it('does not record a pasted URL', async () => {
    expect(
      (await http('POST', '/playback', { url: 'http://192.0.2.1/x.mp4' })).status,
    ).toBeLessThan(500);
    expect(await history()).toEqual({ items: [] });
  });

  it('replays the same release with a fresh relay URL and moves it to the top', async () => {
    await playFromList('series', EP);
    await playFromList('movie', 'tt0111161');
    expect(opens()).toHaveLength(2);

    const res = await http('POST', `/playback/history/${encodeURIComponent(EP)}/play`);
    expect(res.status).toBe(202);
    expect(opens()).toHaveLength(3);
    const first = (opens()[0]?.params as { item: { file: string } }).item.file;
    const again = (opens()[2]?.params as { item: { file: string } }).item.file;
    expect(again).toMatch(/\/api\/relay\/[\w-]{22}\/Show\.S01E04\.1080p\.WEB-DL\.mkv$/);
    expect(again).not.toBe(first);
    expect((await history()).items.map((i) => i.id)).toEqual([EP, 'tt0111161']);
  });

  it('answers 404 for an unknown id', async () => {
    expect((await http('POST', '/playback/history/tt9999999/play')).status).toBe(404);
  });

  it('maps an unmatched release to no_matching_source and keeps the entry', async () => {
    await playFromList('series', EP);
    offered = [{ name: 'Other.mkv', group: 'other|720p', cached: true }];
    // Nothing from the same release is cached any more.
    offered = [{ name: 'Show.S01E04.1080p.WEB-DL.mkv', group: GROUP, cached: false }];
    const res = await http('POST', `/playback/history/${encodeURIComponent(EP)}/play`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'no_matching_source' });
    expect((await history()).items.map((i) => i.id)).toEqual([EP]);
  });
});

describe('playback history without AIOStreams (e2e)', () => {
  it('maps a replay to source_not_configured', async () => {
    const saved = ENV.map((k) => [k, process.env[k]] as const);
    for (const k of ENV) delete process.env[k];
    const t = await createTestApp();
    try {
      const token = await pairDevice(t);
      // An entry cannot exist without a play, so write one directly.
      const { PlaybackHistoryStore } = await import('./playback-history.store.js');
      const { DbService } = await import('../db/db.service.js');
      const store = new PlaybackHistoryStore(t.app.get(DbService));
      store.record({
        id: 'tt1',
        type: 'movie',
        titleId: 'tt1',
        name: 'X',
        releaseTitle: 'x.mkv',
        releaseKey: '',
      });
      const res = await t.http('POST', '/playback/history/tt1/play', { token });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: 'source_not_configured' });
    } finally {
      await t.close();
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });
});
