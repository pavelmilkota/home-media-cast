import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  BrowserSession,
  DeviceCaps,
  PlayerEvent,
  StreamsResponse,
} from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../auth/device.service.js';
import { PlayerStatusService } from '../player/player-status.service.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { createFakeSpawn, probeJson, type FakeSpawn } from './testing/fake-ffmpeg.js';

const SECRET = 'PROVIDER-SECRET-KEY';
const ENV = [
  'AIOSTREAMS_URL',
  'AIOSTREAMS_UUID',
  'AIOSTREAMS_PASSWORD',
  'PLAYBACK_ALLOW_HOSTS',
  'CINEMETA_URL',
] as const;
const CAPS: DeviceCaps = {
  h264: true,
  hevc: false,
  hevc10: false,
  vp9: true,
  av1: false,
  hdr: false,
};
const VIDEO_ID = 'tt0111161';
const TITLE = { type: 'movie', id: VIDEO_ID };
const time = (ms: number) => ({
  hours: 0,
  minutes: 0,
  seconds: Math.floor(ms / 1000),
  milliseconds: ms % 1000,
});

describe('handoff (e2e)', () => {
  let t: TestApp;
  let tokenA: string;
  let tokenB: string;
  let servers: Server[];
  let fake: FakeSpawn;
  let searches: number;
  /** A release the household can tell again later (a binge group), or none. */
  let withGroup: boolean;
  let tvActive: boolean;
  let tvPositionMs: number;
  const saved: Record<string, string | undefined> = {};

  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };

  beforeEach(async () => {
    servers = [];
    searches = 0;
    withGroup = true;
    tvActive = false;
    tvPositionMs = 600_000;
    fake = createFakeSpawn();
    const provider = createServer(
      (_req, res) =>
        void res
          .writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1000' })
          .end(Buffer.from([0])),
    );
    const providerPort = await listen(provider);
    const aio = createServer((_req, res) => {
      searches++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          data: {
            results: [
              {
                url: `http://127.0.0.1:${providerPort}/movie.mkv?token=${SECRET}`,
                filename: withGroup ? 'Movie.2023.1080p.mkv' : 'x.mkv',
                service: 'torbox',
                cached: true,
                ...(withGroup ? { bingeGroup: 'grp|1080p', infoHash: 'c'.repeat(40) } : {}),
              },
            ],
            errors: [],
          },
        }),
      );
    });
    const meta = createServer(
      (_req, res) =>
        void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ meta: { id: VIDEO_ID, name: 'The Movie', year: '1994' } })),
    );
    const [aioPort, metaPort] = [await listen(aio), await listen(meta)];
    for (const k of ENV) saved[k] = process.env[k];
    process.env['AIOSTREAMS_URL'] = `http://127.0.0.1:${aioPort}`;
    process.env['AIOSTREAMS_UUID'] = 'u';
    process.env['AIOSTREAMS_PASSWORD'] = 'p';
    process.env['CINEMETA_URL'] = `http://127.0.0.1:${metaPort}`;
    t = await createTestApp(
      (kodi) =>
        kodi
          .on('Player.Open', 'OK')
          .on('Player.Stop', 'OK')
          .on('Player.Seek', {})
          .on('Application.GetProperties', { volume: 40, muted: false })
          .onCall('Player.GetActivePlayers', () =>
            tvActive ? [{ playerid: 1, playertype: 'internal', type: 'video' }] : [],
          )
          .onCall('Player.GetProperties', () => ({
            speed: 1,
            time: time(tvPositionMs),
            totaltime: time(7_200_000),
            audiostreams: [],
            currentaudiostream: null,
            subtitles: [],
            currentsubtitle: null,
            subtitleenabled: false,
          }))
          .on('Player.GetItem', { item: { label: 'x.mkv', type: 'unknown' } }),
      { spawn: fake.spawn },
    );
    tokenA = await pairDevice(t, 'Phone');
    tokenB = t.app.get(DeviceService).create('Laptop').token;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
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

  const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const kodiCalls = (method: string) => t.kodi.requests.filter((r) => r.method === method);
  const http = (m: string, p: string, token: string, body?: unknown) =>
    t.http(m, p, { token, body });
  const media = (path: string) => fetch(`${t.base}${path}`);
  const optionId = async (token = tokenA) =>
    ((await http('GET', `/titles/movie/${VIDEO_ID}/streams`, token)).body as StreamsResponse)
      .options[0]!.id;

  /** Starts a browser session on a device and reports that its player plays. */
  const browserPlay = async (token: string, progressMs?: number) => {
    const res = await http('POST', '/browser-play', token, {
      optionId: await optionId(token),
      title: TITLE,
      caps: CAPS,
      resume: false,
    });
    expect(res.status).toBe(201);
    const session = res.body as BrowserSession;
    expect((await http('POST', `/browser-play/${session.id}/started`, token)).status).toBe(204);
    if (progressMs !== undefined) {
      await http('POST', `/browser-play/${session.id}/progress`, token, {
        positionMs: progressMs,
      });
    }
    return session;
  };

  /** Plays the title on the TV from the catalog, and lets the TV show it. */
  const playOnTv = async (token = tokenA) => {
    const res = await http('POST', '/playback/stream', token, {
      optionId: await optionId(token),
      title: TITLE,
    });
    expect(res.status).toBe(202);
    tvActive = true;
    t.kodi.notify('Player.OnPlay', {});
    await wait();
  };

  const here = (token: string, caps: DeviceCaps = CAPS) =>
    http('POST', '/playback/handoff/here', token, { caps });
  const toTv = (token: string, body: unknown = {}) =>
    http('POST', '/playback/handoff/tv', token, body);

  it('needs a device token, and 404s when nothing plays', async () => {
    expect((await t.http('POST', '/playback/handoff/here', { body: { caps: CAPS } })).status).toBe(
      401,
    );
    expect((await t.http('POST', '/playback/handoff/tv', { body: {} })).status).toBe(401);
    expect((await here(tokenA)).status).toBe(404);
    expect((await toTv(tokenA)).status).toBe(404);
    expect(
      (await http('POST', '/playback/handoff/here', tokenA, { caps: { h264: true } })).status,
    ).toBe(400);
  });

  describe('Continue here', () => {
    it('takes the TV session at the live position, and the TV stops only once the player plays', async () => {
      await playOnTv();
      const res = await here(tokenB);
      expect(res.status).toBe(201);
      const session = res.body as BrowserSession;
      expect(session.run.startMs).toBe(600_000);
      expect(session.mode).toBe('copy');
      expect((await media(session.run.playlistPath)).status).toBe(200);
      // The browser has a session, but the TV is not touched until its player says it plays.
      expect(kodiCalls('Player.Stop')).toHaveLength(0);

      expect((await http('POST', `/browser-play/${session.id}/started`, tokenB)).status).toBe(204);
      expect(kodiCalls('Player.Stop')).toHaveLength(1);
    });

    it('reads the position from Kodi at the moment of the request', async () => {
      await playOnTv();
      tvPositionMs = 1_234_000;
      const session = (await here(tokenB)).body as BrowserSession;
      expect(session.run.startMs).toBe(1_234_000);
    });

    it('takes a session from another browser, which stops only when the new player plays', async () => {
      const first = await browserPlay(tokenA, 120_000);
      const res = await here(tokenB);
      expect(res.status).toBe(201);
      const second = res.body as BrowserSession;
      expect(second.run.startMs).toBe(120_000);
      expect((await media(first.run.playlistPath)).status).toBe(200); // still playing
      await http('POST', `/browser-play/${second.id}/started`, tokenB);
      expect((await media(first.run.playlistPath)).status).toBe(404);
      expect((await media(second.run.playlistPath)).status).toBe(200);
    });

    it("with its own play running too, takes the other device's play", async () => {
      // Its own play started first, so it is the first one a plain lookup finds.
      await browserPlay(tokenB, 1_200_000);
      const theirs = await browserPlay(tokenA, 600_000);
      const res = await here(tokenB);
      expect(res.status).toBe(201);
      const mine = res.body as BrowserSession;
      expect(mine.run.startMs).toBe(600_000);
      await http('POST', `/browser-play/${mine.id}/started`, tokenB);
      expect((await media(theirs.run.playlistPath)).status).toBe(404); // a handoff takes over
    });

    it("works after the playing option expired, from the session's own source", async () => {
      const first = await browserPlay(tokenA, 300_000);
      const real = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => real() + 31 * 60_000);
      const res = await here(tokenB);
      expect(res.status).toBe(201);
      expect((res.body as BrowserSession).run.startMs).toBe(300_000);
      expect((await media(first.run.playlistPath)).status).toBe(200);
    });

    it('from the device that is already playing there is nothing to take', async () => {
      await browserPlay(tokenA, 1000);
      expect((await here(tokenA)).status).toBe(404);
    });

    it('asks to pick a source when this device cannot play it, and the TV keeps playing', async () => {
      await playOnTv();
      fake.probe.json = probeJson({
        streams: [
          { codec_type: 'video', codec_name: 'hevc', height: 2160, pix_fmt: 'yuv420p10le' },
        ],
      });
      const res = await here(tokenB);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'handoff_pick_source',
        pick: { type: 'movie', videoId: VIDEO_ID, positionMs: 600_000 },
      });
      expect(kodiCalls('Player.Stop')).toHaveLength(0);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('grp|1080p');
    });

    it('finds the same release again when the option expired', async () => {
      await playOnTv();
      const real = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => real() + 31 * 60_000);
      const before = searches;
      const res = await here(tokenB);
      expect(res.status).toBe(201);
      expect(searches).toBeGreaterThan(before); // it looked for the release key
    });

    it('never accepts "any release" for an expired option without a release key: it asks', async () => {
      withGroup = false;
      await playOnTv();
      const real = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => real() + 31 * 60_000);
      const before = searches;
      const res = await here(tokenB);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'handoff_pick_source' });
      expect(searches).toBe(before); // no search at all, so no look-alike could be picked
      expect(kodiCalls('Player.Stop')).toHaveLength(0);
    });
  });

  describe('Send to TV', () => {
    it('saves the position, plays on the TV and resumes there; the browser ends once the TV plays', async () => {
      const session = await browserPlay(tokenA, 1_800_000);
      const res = await toTv(tokenB, {});
      expect(res.status).toBe(204);
      expect(kodiCalls('Player.Open')).toHaveLength(1);
      expect((await media(session.run.playlistPath)).status).toBe(200); // until the TV shows it

      tvActive = true;
      tvPositionMs = 0;
      t.kodi.notify('Player.OnPlay', {});
      await wait(600);
      expect(JSON.stringify(kodiCalls('Player.Seek')[0]?.params)).toContain('"minutes":30');
      expect((await media(session.run.playlistPath)).status).toBe(404);
    });

    it("with two devices playing, sends the sender's own play and leaves the other's", async () => {
      const theirs = await browserPlay(tokenA, 600_000);
      const mine = await browserPlay(tokenB, 1_200_000);
      expect((await toTv(tokenB, {})).status).toBe(204);
      tvActive = true;
      tvPositionMs = 0;
      t.kodi.notify('Player.OnPlay', {});
      await wait(600);
      expect(JSON.stringify(kodiCalls('Player.Seek')[0]?.params)).toContain('"minutes":20');
      expect((await media(mine.run.playlistPath)).status).toBe(404);
      expect((await media(theirs.run.playlistPath)).status).toBe(200);
    });

    it("sends the sender's own position when it gives one", async () => {
      await browserPlay(tokenA, 60_000);
      expect((await toTv(tokenA, { positionMs: 2_400_000 })).status).toBe(204);
      tvActive = true;
      t.kodi.notify('Player.OnPlay', {});
      await wait(600);
      expect(JSON.stringify(kodiCalls('Player.Seek')[0]?.params)).toContain('"minutes":40');
    });

    it('finds the same release by its key when the option expired', async () => {
      await browserPlay(tokenA, 1_800_000);
      const real = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => real() + 31 * 60_000);
      const before = searches;
      expect((await toTv(tokenA)).status).toBe(204);
      expect(searches).toBeGreaterThan(before);
      expect(kodiCalls('Player.Open')).toHaveLength(1);
    });

    it('with neither the option nor a key asks to pick, and the browser keeps playing', async () => {
      withGroup = false;
      const session = await browserPlay(tokenA, 1_800_000);
      const real = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => real() + 31 * 60_000);
      const before = searches;
      const res = await toTv(tokenA);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'handoff_pick_source',
        pick: { type: 'movie', videoId: VIDEO_ID, positionMs: 1_800_000 },
      });
      expect(searches).toBe(before); // never "any release"
      expect(kodiCalls('Player.Open')).toHaveLength(0);
      expect((await media(session.run.playlistPath)).status).toBe(200);
    });
  });

  it('shows every device what plays in a browser, with no media id, link or release key', async () => {
    const events: PlayerEvent[] = [];
    const sub = t.app
      .get(PlayerStatusService)
      .stream()
      .subscribe((e) => events.push(e));
    try {
      const session = await browserPlay(tokenA, 90_000);
      await wait(50);
      const browser = events.filter((e) => e.type === 'browser');
      expect(browser.at(-1)?.data).toMatchObject({
        active: true,
        deviceName: 'Phone',
        media: { name: 'The Movie' },
        positionMs: 90_000,
      });
      const text = JSON.stringify(browser);
      for (const secret of [session.id, SECRET, 'grp|1080p', 'c'.repeat(40), VIDEO_ID]) {
        expect(text).not.toContain(secret);
      }
      await http('DELETE', `/browser-play/${session.id}`, tokenA);
      await wait(50);
      expect(events.filter((e) => e.type === 'browser').at(-1)?.data).toEqual({ active: false });
    } finally {
      sub.unsubscribe();
    }
  });

  it('a new TV playback leaves a copy play in a browser running (a pasted link counts)', async () => {
    const session = await browserPlay(tokenA, 90_000);
    await wait(100);
    tvActive = true;
    t.kodi.notify('Player.OnPlay', {});
    await wait(500);
    expect((await media(session.run.playlistPath)).status).toBe(200);
  });
});
