import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserSession, DeviceCaps, ExternalSession } from '@home-media-cast/shared';
import type { StreamsResponse } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceService } from '../auth/device.service.js';
import { DbService } from '../db/db.service.js';
import { lastSource, playbackHistory, progress, settings } from '../db/schema.js';
import { PairingService } from '../pairing/pairing.service.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { BrowserSessionService, PLAYER_ALIVE_MS } from './browser-session.service.js';
import { ExternalSessionService, READING_MS } from './external-session.service.js';
import { createFakeSpawn, type FakeSpawn } from './testing/fake-ffmpeg.js';

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

describe('guest sessions (e2e)', () => {
  let t: TestApp;
  let phone: string; // paired
  let guest: string;
  let guest2: string;
  let servers: Server[];
  let fake: FakeSpawn;
  let tvActive: boolean;
  /** The clock the session services see. */
  let clock: number;
  const saved: Record<string, string | undefined> = {};

  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };

  beforeEach(async () => {
    servers = [];
    tvActive = false;
    clock = Date.now();
    fake = createFakeSpawn();
    const provider = createServer(
      (_req, res) =>
        void res
          .writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1000' })
          .end(Buffer.from([0])),
    );
    const providerPort = await listen(provider);
    const aio = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            success: true,
            data: {
              results: [
                {
                  url: `http://127.0.0.1:${providerPort}/movie.mkv`,
                  filename: 'Movie.2023.1080p.mkv',
                  service: 'torbox',
                  cached: true,
                  bingeGroup: 'grp|1080p',
                  infoHash: 'c'.repeat(40),
                },
              ],
              errors: [],
            },
          }),
        ),
    );
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
          .on('Application.GetProperties', { volume: 40, muted: false })
          .onCall('Player.GetActivePlayers', () =>
            tvActive ? [{ playerid: 1, playertype: 'internal', type: 'video' }] : [],
          )
          .onCall('Player.GetProperties', () => ({
            speed: 1,
            time: time(600_000),
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
    phone = await pairDevice(t, 'Phone');
    const devices = t.app.get(DeviceService);
    guest = devices.createGuest('Guest one').token;
    guest2 = devices.createGuest('Guest two').token;
    // The services read their clock at construction, so a spy on Date would not reach them.
    (t.app.get(BrowserSessionService) as unknown as { now: () => number }).now = () => clock;
    (t.app.get(ExternalSessionService) as unknown as { now: () => number }).now = () => clock;
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

  const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const kodiCalls = (method: string) => t.kodi.requests.filter((r) => r.method === method);
  const http = (m: string, p: string, token: string, body?: unknown) =>
    t.http(m, p, { token, body });
  const media = (path: string) => fetch(`${t.base}${path}`);
  const optionId = async (token: string) =>
    ((await http('GET', `/titles/movie/${VIDEO_ID}/streams`, token)).body as StreamsResponse)
      .options[0]!.id;
  const rows = () => {
    const orm = t.app.get(DbService).orm;
    return {
      progress: orm.select().from(progress).all(),
      history: orm.select().from(playbackHistory).all(),
      lastSource: orm.select().from(lastSource).all(),
      settings: orm.select().from(settings).all(),
    };
  };

  const startBrowser = (token: string, extra: Record<string, unknown> = {}) =>
    http('POST', '/browser-play', token, {
      optionId: undefined,
      title: TITLE,
      caps: CAPS,
      ...extra,
    });
  /** Starts a browser session and reports that its player plays. */
  const browserPlay = async (token: string, extra: Record<string, unknown> = {}) => {
    const res = await startBrowser(token, { optionId: await optionId(token), ...extra });
    expect(res.status).toBe(201);
    const session = res.body as BrowserSession;
    expect((await http('POST', `/browser-play/${session.id}/started`, token)).status).toBe(204);
    return session;
  };
  const report = (token: string, session: BrowserSession, positionMs: number) =>
    http('POST', `/browser-play/${session.id}/progress`, token, { positionMs });
  const externalStart = async (token: string) => {
    const res = await http('POST', '/browser-play/external', token, {
      optionId: await optionId(token),
      title: TITLE,
    });
    expect(res.status).toBe(201);
    return res.body as ExternalSession;
  };
  const playOnTv = async () => {
    const res = await http('POST', '/playback/stream', phone, {
      optionId: await optionId(phone),
      title: TITLE,
    });
    expect(res.status).toBe(202);
    tvActive = true;
    t.kodi.notify('Player.OnPlay', {});
    await wait();
  };

  describe('the TV and guests leave each other alone', () => {
    it('a guest confirming while the TV plays stops nothing on the TV', async () => {
      await playOnTv();
      const session = await browserPlay(guest);
      expect(kodiCalls('Player.Stop')).toHaveLength(0);
      expect((await media(session.run.playlistPath)).status).toBe(200);
    });

    it('a guest external session reading while the TV plays stops nothing on the TV', async () => {
      await playOnTv();
      const session = await externalStart(guest);
      expect((await media(session.path)).status).toBeLessThan(300);
      expect(kodiCalls('Player.Stop')).toHaveLength(0);
    });

    it('the TV starting something leaves copy plays running, a paired one and a guest', async () => {
      const mine = await browserPlay(phone);
      expect((await media(mine.run.playlistPath)).status).toBe(200);
      await playOnTv();
      expect((await media(mine.run.playlistPath)).status).toBe(200);

      // A second TV start while a guest plays: the guest keeps playing.
      tvActive = false;
      t.kodi.notify('Player.OnStop', {});
      await wait();
      const theirs = await browserPlay(guest);
      await playOnTv();
      expect((await media(theirs.run.playlistPath)).status).toBe(200);
    });

    it('the TV starting leaves a guest external session running', async () => {
      const session = await externalStart(guest);
      expect((await media(session.path)).status).toBeLessThan(300);
      await playOnTv();
      expect((await media(session.path)).status).toBeLessThan(300);
    });
  });

  describe('players alongside each other', () => {
    it('a guest starts while a paired device plays, and both keep playing', async () => {
      const mine = await browserPlay(phone);
      await report(phone, mine, 60_000);
      const theirs = await browserPlay(guest);
      expect((await media(mine.run.playlistPath)).status).toBe(200);
      expect((await media(theirs.run.playlistPath)).status).toBe(200);
    });

    it('a guest starts while another guest plays', async () => {
      const first = await browserPlay(guest);
      const second = await browserPlay(guest2);
      expect((await media(first.run.playlistPath)).status).toBe(200);
      expect((await media(second.run.playlistPath)).status).toBe(200);
    });

    it('a guest external player starts while a browser player is open', async () => {
      const mine = await browserPlay(phone);
      const ext = await externalStart(guest);
      expect((await media(ext.path)).status).toBeLessThan(300);
      expect((await media(mine.run.playlistPath)).status).toBe(200);
    });

    it('a guest start ends another player that has been silent for 5 minutes', async () => {
      const mine = await browserPlay(phone);
      await report(phone, mine, 60_000);
      clock += PLAYER_ALIVE_MS + 1000;
      const res = await startBrowser(guest, { optionId: await optionId(guest) });
      expect(res.status).toBe(201);
      expect((await media(mine.run.playlistPath)).status).toBe(404);
    });

    it('a guest start leaves a reading external player, and ends it after a silent minute', async () => {
      const ext = await externalStart(phone);
      expect((await media(ext.path)).status).toBeLessThan(300);
      expect((await startBrowser(guest, { optionId: await optionId(guest) })).status).toBe(201);
      expect((await media(ext.path)).status).toBeLessThan(300);
      clock += READING_MS + 1000;
      expect((await startBrowser(guest, { optionId: await optionId(guest) })).status).toBe(201);
      expect((await media(ext.path)).status).toBe(404);
    });

    it("a paired copy play runs alongside a guest's", async () => {
      const theirs = await browserPlay(guest);
      const mine = await browserPlay(phone);
      expect((await media(theirs.run.playlistPath)).status).toBe(200);
      expect((await media(mine.run.playlistPath)).status).toBe(200);
    });

    it('a device starting again replaces only its own session', async () => {
      const theirs = await browserPlay(guest);
      const before = await browserPlay(phone);
      const mine = await browserPlay(phone);
      expect((await media(theirs.run.playlistPath)).status).toBe(200);
      expect((await media(before.run.playlistPath)).status).toBe(404);
      expect((await media(mine.run.playlistPath)).status).toBe(200);
      expect(t.app.get(BrowserSessionService).activeCount).toBe(2);
    });
  });

  describe('a guest writes nothing', () => {
    it('leaves progress, last source, history and track choices alone, and resumes from startMs only', async () => {
      // The household has a resume point of its own.
      const mine = await browserPlay(phone, { resume: false });
      await report(phone, mine, 900_000);
      await http('DELETE', `/browser-play/${mine.id}`, phone);
      const before = rows();
      expect(before.progress).toHaveLength(1);

      const res = await startBrowser(guest, { optionId: await optionId(guest) });
      expect(res.status).toBe(201);
      const session = res.body as BrowserSession;
      expect(session.run.startMs).toBe(0); // not the household's 900 000
      await http('POST', `/browser-play/${session.id}/started`, guest);
      await report(guest, session, 1_500_000);
      await http('POST', `/browser-play/${session.id}/audio`, guest, { index: 0 });
      await http('POST', `/browser-play/${session.id}/subtitle`, guest, { index: null });
      expect(rows()).toEqual(before);
      await http('DELETE', `/browser-play/${session.id}`, guest);
      expect(rows()).toEqual(before);

      const resumed = await startBrowser(guest, {
        optionId: await optionId(guest),
        startMs: 42_000,
      });
      expect((resumed.body as BrowserSession).run.startMs).toBe(42_000);
      expect(rows()).toEqual(before);
    });

    it('a guest external play saves nothing either', async () => {
      const before = rows();
      const ext = await externalStart(guest);
      expect((await media(ext.path)).status).toBeLessThan(300);
      expect(rows()).toEqual(before);
    });

    it('after promotion mid-session, progress is saved', async () => {
      const session = await browserPlay(guest);
      await report(guest, session, 100_000);
      expect(rows().progress).toHaveLength(0);

      (
        t.app.get(PairingService, { strict: false }) as unknown as { lastStartAt: number }
      ).lastStartAt = 0; // the beforeEach pairing was a moment ago
      await t.http('POST', '/pairing/start');
      const shown = t.kodi.requests.findLast((r) => r.method === 'GUI.ShowNotification');
      const code = /\d{6}/.exec(JSON.stringify(shown?.params))![0];
      const done = await fetch(`${t.base}/pairing/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${guest}` },
        body: JSON.stringify({ code, deviceName: 'Paired now' }),
      });
      const { token } = (await done.json()) as { token: string };
      // The film keeps playing under the new token, with the same session.
      expect((await media(session.run.playlistPath)).status).toBe(200);
      expect((await report(token, session, 200_000)).status).toBe(204);
      expect(rows().progress).toMatchObject([{ positionMs: 200_000 }]);
    });
  });

  describe('paired devices and a guest session', () => {
    it('are shown the guest, "here" takes it, and the guest ends once the phone plays', async () => {
      const theirs = await browserPlay(guest);
      await report(guest, theirs, 300_000);
      const res = await http('POST', '/playback/handoff/here', phone, { caps: CAPS });
      expect(res.status).toBe(201);
      const mine = res.body as BrowserSession;
      expect(mine.run.startMs).toBe(300_000);
      await http('POST', `/browser-play/${mine.id}/started`, phone);
      expect((await media(theirs.run.playlistPath)).status).toBe(404);
    });

    it('"tv" saves the position, plays on the TV, and ends the guest once the TV starts', async () => {
      const theirs = await browserPlay(guest);
      await report(guest, theirs, 450_000);
      const res = await http('POST', '/playback/handoff/tv', phone, {});
      expect(res.status).toBe(204);
      expect(kodiCalls('Player.Open')).toHaveLength(1);
      expect(rows().progress).toMatchObject([{ positionMs: 450_000 }]);
      expect((await media(theirs.run.playlistPath)).status).toBe(200); // until the TV shows it
      tvActive = true;
      t.kodi.notify('Player.OnPlay', {});
      await wait();
      expect((await media(theirs.run.playlistPath)).status).toBe(404);
    });
  });

  it('a guest replays from the history while a paired device plays', async () => {
    const mine = await browserPlay(phone); // also puts the title in the history
    const res = await http('POST', `/playback/handoff/replay/${VIDEO_ID}`, guest, { caps: CAPS });
    expect(res.status).toBe(201);
    expect((await media(mine.run.playlistPath)).status).toBe(200);
  });
});
