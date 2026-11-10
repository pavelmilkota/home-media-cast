import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  BrowserSession,
  DeviceCaps,
  PlaybackHistoryResponse,
  StreamsResponse,
} from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { createFakeSpawn, type FakeSpawn } from './testing/fake-ffmpeg.js';

const ENV = [
  'AIOSTREAMS_URL',
  'AIOSTREAMS_UUID',
  'AIOSTREAMS_PASSWORD',
  'CINEMETA_URL',
  'AUTO_NEXT_EPISODE',
] as const;
const CAPS: DeviceCaps = {
  h264: true,
  hevc: false,
  hevc10: false,
  vp9: true,
  av1: false,
  hdr: false,
};
const SHOW = 'tt7049682';

describe('series in the browser player (e2e)', () => {
  let t: TestApp;
  let token: string;
  let servers: Server[];
  let fake: FakeSpawn;
  let searched: string[];
  /** The release the household watches; episodes may offer it or not. */
  let sameRelease: boolean;
  let withKey: boolean;
  const saved: Record<string, string | undefined> = {};

  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };

  const boot = async (env: Record<string, string> = {}) => {
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, env);
    t = await createTestApp(() => undefined, { spawn: fake.spawn });
    token = await pairDevice(t, 'Phone');
  };

  beforeEach(async () => {
    servers = [];
    searched = [];
    sameRelease = true;
    withKey = true;
    fake = createFakeSpawn();
    const provider = createServer(
      (_req, res) =>
        void res
          .writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1000' })
          .end(Buffer.from([0])),
    );
    const providerPort = await listen(provider);
    const aio = createServer((req, res) => {
      searched.push(
        decodeURIComponent(new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''),
      );
      const item = (name: string, group: string | undefined) => ({
        url: `http://127.0.0.1:${providerPort}/dl`,
        filename: name,
        service: 'torbox',
        cached: true,
        ...(group ? { bingeGroup: group } : {}),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          data: {
            results: [
              item('Other.release.mkv', withKey ? 'other|720p' : undefined),
              ...(sameRelease ? [item('Same.release.mkv', withKey ? 'rel|1080p' : undefined)] : []),
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
              id: SHOW,
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
    delete process.env['AUTO_NEXT_EPISODE'];
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

  const http = (m: string, p: string, body?: unknown) => t.http(m, p, { token, body });
  const media = (path: string) => fetch(`${t.base}${path}`);
  const startEpisode = async (n: number, name = 'Same.release.mkv') => {
    const list = await http('GET', `/titles/series/${SHOW}%3A1%3A${n}/streams`);
    const pick = (list.body as StreamsResponse).options.find((o) => o.title === name)!;
    const res = await http('POST', '/browser-play', {
      optionId: pick.id,
      title: { type: 'series', id: `${SHOW}:1:${n}` },
      caps: CAPS,
    });
    expect(res.status).toBe(201);
    return res.body as BrowserSession;
  };
  const skip = (session: BrowserSession, direction: 'next' | 'previous') =>
    http('POST', `/browser-play/${session.id}/${direction}`, { caps: CAPS });

  describe('next and previous', () => {
    beforeEach(() => boot());

    it('lists the neighbours and says the next episode starts by itself', async () => {
      const session = await startEpisode(4);
      expect(session.autoNext).toBe(true);
      expect(session.adjacent?.previous?.videoId).toBe(`${SHOW}:1:3`);
      expect(session.adjacent?.next?.videoId).toBe(`${SHOW}:1:5`);
      expect(JSON.stringify(session)).not.toContain('rel|1080p');
    });

    it('next plays the same release of the next episode in a new session, ending the old one', async () => {
      const first = await startEpisode(4);
      const res = await skip(first, 'next');
      expect(res.status).toBe(200);
      const next = res.body as BrowserSession;
      expect(next.id).not.toBe(first.id);
      expect(searched).toContain(`${SHOW}:1:5`);
      expect((await media(first.run.playlistPath)).status).toBe(404);
      expect((await media(next.run.playlistPath)).status).toBe(200);
      // 1:5 is the last aired episode: nothing after it, and 1:4 is before it.
      expect(next.adjacent?.next).toBeUndefined();
      expect(next.adjacent?.previous?.videoId).toBe(`${SHOW}:1:4`);
    });

    it('previous starts from the beginning, however far the episode was watched', async () => {
      const three = await startEpisode(3);
      await http('POST', `/browser-play/${three.id}/progress`, { positionMs: 1_800_000 });
      const four = (await skip(three, 'next')).body as BrowserSession;
      const back = await skip(four, 'previous');
      expect(back.status).toBe(200);
      expect((back.body as BrowserSession).run.startMs).toBe(0);
      expect(searched).toContain(`${SHOW}:1:3`);
    });

    it('answers no_adjacent_episode at the end, and the player keeps going', async () => {
      const five = await startEpisode(5);
      const res = await skip(five, 'next');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'no_adjacent_episode' });
      expect((await media(five.run.playlistPath)).status).toBe(200);
    });

    it('answers no_matching_source when the next episode has no source from the same release', async () => {
      const four = await startEpisode(4);
      sameRelease = false;
      const res = await skip(four, 'next');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'no_matching_source' });
      expect((await media(four.run.playlistPath)).status).toBe(200);
    });

    it("another device's session cannot be skipped", async () => {
      const four = await startEpisode(4);
      const other = (await import('../auth/device.service.js')).DeviceService;
      const tokenB = t.app.get(other).create('Laptop').token;
      const res = await t.http('POST', `/browser-play/${four.id}/next`, {
        token: tokenB,
        body: { caps: CAPS },
      });
      expect(res.status).toBe(404);
    });

    it('rejects a body without the device capabilities', async () => {
      const four = await startEpisode(4);
      expect((await http('POST', `/browser-play/${four.id}/next`, {})).status).toBe(400);
    });

    it('a movie, or a play without catalog context, has no episodes around it', async () => {
      const list = await http('GET', `/titles/series/${SHOW}%3A1%3A4/streams`);
      const optionId = (list.body as StreamsResponse).options[0]!.id;
      const res = await http('POST', '/browser-play', { optionId, caps: CAPS });
      const session = res.body as BrowserSession;
      expect(session.adjacent).toBeUndefined();
      expect((await skip(session, 'next')).status).toBe(404);
    });
  });

  describe('AUTO_NEXT_EPISODE=false', () => {
    beforeEach(() => boot({ AUTO_NEXT_EPISODE: 'false' }));

    it('does not start the next episode by itself, but the buttons still work', async () => {
      const four = await startEpisode(4);
      expect(four.autoNext).toBe(false);
      expect(four.adjacent?.next?.videoId).toBe(`${SHOW}:1:5`);
      expect((await skip(four, 'next')).status).toBe(200);
    });
  });

  describe('replay from Recent', () => {
    beforeEach(() => boot());
    const replay = (id: string) => http('POST', `/playback/handoff/replay/${id}`, { caps: CAPS });
    const recent = async () =>
      ((await http('GET', '/playback/history')).body as PlaybackHistoryResponse).items;

    it('plays the same release in the browser, found anew, from where the library says', async () => {
      const four = await startEpisode(4);
      await http('POST', `/browser-play/${four.id}/progress`, { positionMs: 1_200_000 });
      const [entry] = await recent();
      const before = searched.length;
      const res = await replay(entry!.id);
      expect(res.status).toBe(201);
      const session = res.body as BrowserSession;
      expect(searched.length).toBeGreaterThan(before); // a fresh search, not a stored link
      expect(session.run.startMs).toBe(1_200_000);
      expect(JSON.stringify(res.body)).not.toContain('rel|1080p');
      expect(fake.ffmpeg().length).toBeGreaterThan(1);
    });

    it('without a release key asks to pick a source instead of taking any release', async () => {
      withKey = false;
      await startEpisode(4);
      const [entry] = await recent();
      const before = searched.length;
      const res = await replay(entry!.id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'handoff_pick_source',
        pick: { type: 'series', videoId: `${SHOW}:1:4` },
      });
      expect(searched.length).toBe(before); // never looked for "any release"
    });

    it('answers 404 for an entry that is gone, and no_matching_source when the release is gone', async () => {
      expect((await replay('nope')).status).toBe(404);
      await startEpisode(4);
      const [entry] = await recent();
      sameRelease = false;
      const res = await replay(entry!.id);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'no_matching_source' });
    });

    it('leaves the TV replay as it was: any release when the entry has no key', async () => {
      const list = await http('GET', `/titles/series/${SHOW}%3A1%3A4/streams`);
      expect(list.status).toBe(200);
      // The TV route is not called with a body and does not need the device's capabilities.
      expect((await http('POST', '/playback/history/nope/play')).status).toBe(404);
    });
  });
});
