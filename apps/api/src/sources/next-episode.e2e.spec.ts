import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdjacentEpisodes } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

const ENV = ['AIOSTREAMS_URL', 'AIOSTREAMS_UUID', 'AIOSTREAMS_PASSWORD', 'CINEMETA_URL'] as const;
const time = (s: number) => ({ hours: 0, minutes: 0, seconds: s, milliseconds: 0 });

describe('next episode (e2e)', () => {
  let t: TestApp;
  let token: string;
  let servers: Server[];
  let searched: string[];
  let positionS: number;
  let active: boolean;
  /** `bingeGroup` of the sources AIOStreams offers for every episode. */
  let group: string;
  const saved: Record<string, string | undefined> = {};

  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };

  beforeEach(async () => {
    servers = [];
    searched = [];
    positionS = 600;
    active = false;
    group = 'rel|1080p';
    const provider = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4' }).end('data'),
    );
    const providerPort = await listen(provider);
    const aio = createServer((req, res) => {
      searched.push(
        decodeURIComponent(new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''),
      );
      const item = (name: string, bingeGroup: string, cached = true) => ({
        url: `http://127.0.0.1:${providerPort}/dl`,
        filename: name,
        service: 'torbox',
        cached,
        bingeGroup,
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          data: {
            results: [
              item('Other.release.mkv', 'other|720p'),
              item('Uncached.mkv', group, false),
              item('Same.release.mkv', group),
            ],
            errors: [],
          },
        }),
      );
    });
    const meta = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            meta: {
              id: 'tt7049682',
              name: 'Some Show',
              videos: [
                {
                  id: 'x',
                  season: 1,
                  number: 3,
                  name: 'Three',
                  firstAired: '2019-12-25T00:00:00Z',
                },
                { id: 'x', season: 1, number: 4, name: 'Four', firstAired: '2020-01-01T00:00:00Z' },
                { id: 'x', season: 1, number: 5, name: 'Five', firstAired: '2020-01-08T00:00:00Z' },
                { id: 'x', season: 1, number: 6, name: 'Six', firstAired: '2999-01-01T00:00:00Z' },
              ],
            },
          }),
        ),
    );
    const [aioPort, metaPort] = [await listen(aio), await listen(meta)];
    for (const k of ENV) saved[k] = process.env[k];
    process.env['AIOSTREAMS_URL'] = `http://127.0.0.1:${aioPort}`;
    process.env['AIOSTREAMS_UUID'] = 'u';
    process.env['AIOSTREAMS_PASSWORD'] = 'p';
    process.env['CINEMETA_URL'] = `http://127.0.0.1:${metaPort}`;
    t = await createTestApp((kodi) =>
      kodi
        .on('Player.Open', 'OK')
        .on('Application.GetProperties', { volume: 40, muted: false })
        .onCall('Player.GetActivePlayers', () =>
          active ? [{ playerid: 1, playertype: 'internal', type: 'video' }] : [],
        )
        .onCall('Player.GetProperties', () => ({
          speed: 1,
          time: time(positionS),
          totaltime: time(3000),
          audiostreams: [],
          currentaudiostream: null,
          subtitles: [],
          currentsubtitle: null,
          subtitleenabled: false,
        }))
        .on('Player.GetItem', { item: { label: 'x.mkv', type: 'unknown' } }),
    );
    token = await pairDevice(t);
  });
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

  const opens = () => t.kodi.requests.filter((r) => r.method === 'Player.Open');
  const http = (m: string, p: string, body?: unknown) => t.http(m, p, { token, body });

  /** Lists the sources of 1:4, plays the one from `group`, and lets the TV show it. */
  const playEpisode4 = async (pickGroupless = false) => {
    const list = await http('GET', '/titles/series/tt7049682%3A1%3A4/streams');
    const options = (list.body as { options: { id: string; title: string }[] }).options;
    const pick = options.find(
      (o) => o.title === (pickGroupless ? 'Other.release.mkv' : 'Same.release.mkv'),
    )!;
    const res = await http('POST', '/playback/stream', {
      optionId: pick.id,
      title: { type: 'series', id: 'tt7049682:1:4' },
    });
    expect(res.status).toBe(202);
    active = true;
    t.kodi.notify('Player.OnPlay', {});
    await new Promise((r) => setTimeout(r, 300));
  };
  const finish = async () => {
    positionS = 2900; // 96 %
    t.kodi.notify('Player.OnSeek', {});
    await new Promise((r) => setTimeout(r, 300));
    active = false;
    t.kodi.notify('Player.OnStop', {});
  };
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30));
  };

  it('needs a token', async () => {
    expect((await t.http('GET', '/playback/episodes')).status).toBe(401);
    expect((await t.http('POST', '/playback/next')).status).toBe(401);
    expect((await t.http('POST', '/playback/previous')).status).toBe(401);
  });

  it('knows nothing about a next episode before anything was played', async () => {
    expect((await http('GET', '/playback/episodes')).body).toEqual({});
    expect((await http('POST', '/playback/next')).status).toBe(404);
    expect((await http('POST', '/playback/previous')).status).toBe(404);
  });

  it('starts the next episode by itself, from the same release and never an uncached one', async () => {
    await playEpisode4();
    expect(opens()).toHaveLength(1);
    const around = (await http('GET', '/playback/episodes')).body as AdjacentEpisodes;
    expect(around).toEqual({
      previous: { videoId: 'tt7049682:1:3', seriesName: 'Some Show', label: 'S1E3 · Three' },
      next: { videoId: 'tt7049682:1:5', seriesName: 'Some Show', label: 'S1E5 · Five' },
    });

    await finish();
    await waitFor(() => opens().length === 2);
    expect(opens()).toHaveLength(2);
    expect(searched.at(-1)).toBe('tt7049682:1:5');
    const file = (opens()[1]?.params as { item: { file: string } }).item.file;
    expect(file).toMatch(/\/api\/relay\/[\w-]{22}\/Same\.release\.mkv$/);
    // The new play is the "last play" now: the one after it is not aired yet.
    expect(
      ((await http('GET', '/playback/episodes')).body as AdjacentEpisodes).next,
    ).toBeUndefined();
    expect(
      ((await http('GET', '/playback/episodes')).body as AdjacentEpisodes).previous?.label,
    ).toBe('S1E4 · Four');
  });

  it('does not advance when stopped early', async () => {
    await playEpisode4();
    active = false;
    t.kodi.notify('Player.OnStop', {});
    await new Promise((r) => setTimeout(r, 400));
    expect(opens()).toHaveLength(1);
  });

  it('plays the next episode on request, from the group of the source that was picked', async () => {
    await playEpisode4(true); // the source picked belongs to the group 'other|720p'
    expect((await http('POST', '/playback/next')).status).toBe(202); // the same group is offered for 1:5
    expect(opens()).toHaveLength(2);
    expect((opens()[1]?.params as { item: { file: string } }).item.file).toMatch(
      /Other\.release\.mkv$/,
    );
  });

  it('goes back to the previous episode from its start, from the same release', async () => {
    await playEpisode4();
    expect((await http('POST', '/playback/next')).status).toBe(202); // 1:5
    expect(opens()).toHaveLength(2);
    t.kodi.requests.length = 0;
    expect((await http('POST', '/playback/previous')).status).toBe(202); // back to 1:4
    expect(searched.at(-1)).toBe('tt7049682:1:4');
    expect(opens()).toHaveLength(1);
    expect((opens()[0]?.params as { item: { file: string } }).item.file).toMatch(
      /Same\.release\.mkv$/,
    );
    // 1:4 was left at 20 %, but "previous" starts it over.
    active = true;
    t.kodi.notify('Player.OnPlay', {});
    await new Promise((r) => setTimeout(r, 400));
    expect(t.kodi.requests.filter((r) => r.method === 'Player.Seek')).toHaveLength(0);
  });

  it('answers 404 when there is no episode before the first one', async () => {
    const list = await http('GET', '/titles/series/tt7049682%3A1%3A3/streams');
    const pick = (list.body as { options: { id: string; title: string }[] }).options.find(
      (o) => o.title === 'Same.release.mkv',
    )!;
    await http('POST', '/playback/stream', {
      optionId: pick.id,
      title: { type: 'series', id: 'tt7049682:1:3' },
    });
    const res = await http('POST', '/playback/previous');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'no_adjacent_episode' });
  });

  it('answers 404 no_matching_source when the next episode has no source from that release', async () => {
    await playEpisode4();
    group = 'different'; // AIOStreams now offers the next episode from another release only
    const res = await http('POST', '/playback/next');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'no_matching_source' });
    expect(opens()).toHaveLength(1);
  });

  describe('queue', () => {
    /** Queues the episode `n` of the show, picking the source of the current release group. */
    const enqueue = async (n: number) => {
      const id = `tt7049682:1:${n}`;
      const list = await http('GET', `/titles/series/${encodeURIComponent(id)}/streams`);
      const pick = (list.body as { options: { id: string; title: string }[] }).options.find(
        (o) => o.title === 'Same.release.mkv',
      )!;
      return http('POST', '/queue', { optionId: pick.id, title: { type: 'series', id } });
    };

    it('needs a token', async () => {
      expect((await t.http('GET', '/queue')).status).toBe(401);
      expect((await t.http('POST', '/queue/next')).status).toBe(401);
    });

    it('lists, removes and clears entries without exposing a source', async () => {
      const first = await enqueue(3);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        videoId: 'tt7049682:1:3',
        name: 'Some Show',
        label: 'S1E3 · Three',
      });
      await enqueue(5);
      const list = (await http('GET', '/queue')).body as { items: { id: string }[] };
      expect(list.items).toHaveLength(2);
      expect(JSON.stringify(list)).not.toMatch(/rel\||127\.0\.0\.1|bingeGroup/);
      expect((await http('DELETE', `/queue/${list.items[0]!.id}`)).status).toBe(204);
      expect((await http('DELETE', `/queue/${list.items[0]!.id}`)).status).toBe(404);
      expect((await http('DELETE', '/queue')).status).toBe(204);
      expect(((await http('GET', '/queue')).body as { items: unknown[] }).items).toEqual([]);
      expect((await http('POST', '/queue/next')).status).toBe(404);
    });

    it('rejects a bad body', async () => {
      const res = await http('POST', '/queue', {
        optionId: 'x',
        title: { type: 'movie', id: 'nope' },
      });
      expect(res.status).toBe(400);
    });

    it('plays the queue before the automatic next episode', async () => {
      await playEpisode4();
      await enqueue(3);
      await finish();
      await waitFor(() => opens().length === 2);
      expect(opens()).toHaveLength(2);
      expect(searched.at(-1)).toBe('tt7049682:1:3'); // not 1:5
      expect(((await http('GET', '/queue')).body as { items: unknown[] }).items).toEqual([]);
    });

    it('plays the first entry on request, and skips one with no source', async () => {
      await enqueue(5);
      await enqueue(4);
      group = 'different'; // sources are now offered from another release only
      expect((await http('POST', '/queue/next')).status).toBe(404);
      expect(opens()).toHaveLength(0);
      expect(((await http('GET', '/queue')).body as { items: unknown[] }).items).toEqual([]);
    });
  });
});
