import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExternalSession, PlayerEvent, StreamsResponse } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceService } from '../auth/device.service.js';
import { SessionHub } from './session-hub.js';
import { PlayerStatusService } from '../player/player-status.service.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { createFakeSpawn, type FakeSpawn } from './testing/fake-ffmpeg.js';

const SECRET = 'PROVIDER-SECRET-KEY';
const HASH = 'd'.repeat(40);
const BODY = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 251));
const ENV = [
  'AIOSTREAMS_URL',
  'AIOSTREAMS_UUID',
  'AIOSTREAMS_PASSWORD',
  'PLAYBACK_ALLOW_HOSTS',
  'CINEMETA_URL',
] as const;
const TITLE = { type: 'movie', id: 'tt0111161' };
const time = (ms: number) => ({
  hours: 0,
  minutes: 0,
  seconds: Math.floor(ms / 1000),
  milliseconds: ms % 1000,
});

describe('external player (e2e)', () => {
  let t: TestApp;
  let token: string;
  let tokenB: string;
  let servers: Server[];
  let fake: FakeSpawn;
  let providerPort: number;
  let providerHits: number;
  let rejectLinks: boolean;
  let slow: boolean;
  let tvActive: boolean;
  let tvTitle: string;
  const saved: Record<string, string | undefined> = {};

  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as AddressInfo).port;
  };

  beforeEach(async () => {
    servers = [];
    providerHits = 0;
    rejectLinks = false;
    slow = false;
    tvActive = false;
    tvTitle = 'x.mkv';
    fake = createFakeSpawn();
    const provider = createServer((req, res) => {
      providerHits++;
      const url = new URL(req.url ?? '/', 'http://x');
      if (rejectLinks || url.searchParams.get('token') !== SECRET) {
        return void res.writeHead(403).end();
      }
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), BODY.length - 1) : BODY.length - 1;
      res.writeHead(m ? 206 : 200, {
        'content-type': 'video/x-matroska',
        'accept-ranges': 'bytes',
        ...(slow ? {} : { 'content-length': String(end - start + 1) }),
        ...(m ? { 'content-range': `bytes ${start}-${end}/${BODY.length}` } : {}),
        'x-powered-by': `leak-${SECRET}`,
      });
      if (!slow || req.headers.range === 'bytes=0-0') {
        return void res.end(req.method === 'HEAD' ? undefined : BODY.subarray(start, end + 1));
      }
      res.write(BODY.subarray(start, start + 1000));
      const timer = setInterval(() => res.write(Buffer.alloc(1000)), 10);
      res.on('close', () => clearInterval(timer));
    });
    providerPort = await listen(provider);
    const aio = createServer(
      (_req, res) =>
        void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            success: true,
            data: {
              results: [
                {
                  url: `http://127.0.0.1:${providerPort}/movie.mkv?token=${SECRET}`,
                  infoHash: HASH,
                  filename: 'Movie.2023.2160p.mkv',
                  service: 'torbox',
                  cached: true,
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
          .end(JSON.stringify({ meta: { id: 'tt0111161', name: 'The Movie', year: '1994' } })),
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
          .onCall('Player.GetItem', () => ({ item: { label: tvTitle, type: 'unknown' } })),
      { spawn: fake.spawn },
    );
    token = await pairDevice(t, 'Phone');
    tokenB = t.app.get(DeviceService).create('Laptop').token;
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
  const optionId = async () =>
    ((await t.http('GET', '/titles/movie/tt0111161/streams', { token })).body as StreamsResponse)
      .options[0]!.id;
  const startExternal = async (over: Record<string, unknown> = {}, as = token) =>
    t.http('POST', '/browser-play/external', {
      token: as,
      body: { optionId: await optionId(), title: TITLE, ...over },
    });
  const started = async (as = token): Promise<ExternalSession> => {
    const res = await startExternal({}, as);
    expect(res.status).toBe(201);
    return res.body as ExternalSession;
  };
  const file = (path: string, init?: RequestInit) => fetch(`${t.base}${path}`, init);

  it('needs a device token for the control routes, but not for the file', async () => {
    expect((await t.http('POST', '/browser-play/external', { body: {} })).status).toBe(401);
    expect((await t.http('DELETE', '/browser-play/external/x')).status).toBe(401);
    expect((await t.http('POST', '/browser-play/x/external', { body: {} })).status).toBe(401);
    const session = await started();
    expect((await file(session.path)).status).toBe(200); // the id in the path is the capability
  });

  it('rejects a malformed start and an unknown option', async () => {
    expect((await t.http('POST', '/browser-play/external', { token, body: {} })).status).toBe(400);
    expect((await startExternal({ extra: 1 })).status).toBe(400);
    expect((await startExternal({ optionId: 'nope' })).status).toBe(410);
  });

  it('serves the source with Range and HEAD under a file name, and nothing of the provider', async () => {
    const session = await started();
    expect(session.path).toMatch(/^\/media\/[\w-]+\/file\/Movie\.2023\.2160p\.mkv$/);
    expect(session.durationMs).toBe(7_200_500);
    expect(session.handoffId).toHaveLength(16);

    const whole = await file(session.path);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(BODY)).toBe(true);
    expect(JSON.stringify([...whole.headers])).not.toContain('leak');
    expect(whole.headers.get('cache-control')).toBe('no-store');

    const part = await file(session.path, { headers: { range: 'bytes=1000-1999' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 1000-1999/${BODY.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(BODY.subarray(1000, 2000))).toBe(true);

    const head = await file(session.path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(BODY.length));
  });

  it('answers 404 for an unknown id and for a session that ended', async () => {
    expect((await file('/media/nope/file/x.mkv')).status).toBe(404);
    const session = await started();
    expect((await file(session.path)).status).toBe(200);
    const id = session.path.split('/')[2]!;
    expect((await t.http('DELETE', `/browser-play/external/${id}`, { token: tokenB })).status).toBe(
      404,
    ); // another device's session looks like none
    expect((await file(session.path)).status).toBe(200);
    expect((await t.http('DELETE', `/browser-play/external/${id}`, { token })).status).toBe(204);
    expect((await file(session.path)).status).toBe(404);
  });

  it('ending the session cuts off an open response, which is how the player is stopped', async () => {
    slow = true;
    const session = await started();
    const res = await file(session.path, { headers: { range: 'bytes=0-' } });
    expect(res.status).toBe(206);
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const id = session.path.split('/')[2]!;
    await t.http('DELETE', `/browser-play/external/${id}`, { token });
    const outcome = await (async () => {
      for (let i = 0; i < 200; i++) {
        const r = await reader.read();
        if (r.done) return 'closed';
      }
      return 'still streaming';
    })().catch(() => 'closed');
    expect(outcome).toBe('closed');
  });

  it('registers the link again once when the provider drops it', async () => {
    const session = await started();
    const before = providerHits;
    rejectLinks = true;
    const dead = await file(session.path);
    expect(dead.status).toBe(502);
    expect(providerHits).toBeGreaterThan(before);
    rejectLinks = false;
    // The relay entry was replaced by a fresh one from the session's own source.
    expect((await file(session.path)).status).toBe(200);
  });

  it('plays alongside: its first read leaves the TV playing', async () => {
    tvActive = true;
    t.kodi.notify('Player.OnPlay', {});
    const session = await started();
    await (await file(session.path)).arrayBuffer();
    expect(kodiCalls('Player.Stop')).toHaveLength(0);
  });

  it('a read of the end of the file (an index) does not count as playing', async () => {
    const session = await started();
    const hub = t.app.get(SessionHub);
    const tail = await file(session.path, { headers: { range: `bytes=${BODY.length - 1000}-` } });
    await tail.arrayBuffer();
    expect(hub.active()).toBeUndefined();
    await (await file(session.path)).arrayBuffer();
    expect(hub.active()?.kind).toBe('external');
  });

  it("leaves another device's browser session playing", async () => {
    const other = (
      await t.http('POST', '/browser-play', {
        token: tokenB,
        body: {
          optionId: await optionId(),
          caps: { h264: true, hevc: true, hevc10: true, vp9: true, av1: true, hdr: true },
        },
      })
    ).body as { id: string; run: { playlistPath: string } };
    await t.http('POST', `/browser-play/${other.id}/started`, { token: tokenB });
    const session = await started();
    await (await file(session.path)).arrayBuffer();
    expect((await file(other.run.playlistPath)).status).toBe(200);
  });

  it('a new playback on the TV leaves the external session running', async () => {
    const session = await started();
    await (await file(session.path)).arrayBuffer();
    tvActive = true;
    tvTitle = 'youtube.mp4';
    t.kodi.notify('Player.OnPlay', {});
    await wait(500);
    expect((await file(session.path)).status).toBeLessThan(300);
  });

  it('shows other devices what plays, marked approximate, without ids or links', async () => {
    const events: PlayerEvent[] = [];
    const sub = t.app
      .get(PlayerStatusService)
      .stream()
      .subscribe((e) => events.push(e));
    try {
      const session = await started();
      await (await file(session.path)).arrayBuffer();
      await wait(50);
      const browser = events.filter((e) => e.type === 'browser').at(-1);
      expect(browser?.data).toMatchObject({
        active: true,
        deviceName: 'Phone',
        approximate: true,
        media: { name: 'The Movie' },
      });
      const text = JSON.stringify(events.filter((e) => e.type === 'browser'));
      for (const secret of [session.path.split('/')[2]!, SECRET, HASH, 'tt0111161']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      sub.unsubscribe();
    }
  });

  it('opens what a browser session plays in an external player, from its position', async () => {
    const browser = (
      await t.http('POST', '/browser-play', {
        token,
        body: {
          optionId: await optionId(),
          title: TITLE,
          resume: false,
          caps: { h264: true, hevc: true, hevc10: true, vp9: true, av1: true, hdr: true },
        },
      })
    ).body as { id: string };
    await t.http('POST', `/browser-play/${browser.id}/progress`, {
      token,
      body: { positionMs: 754_000 },
    });
    const res = await t.http('POST', `/browser-play/${browser.id}/external`, { token, body: {} });
    expect(res.status).toBe(201);
    expect((res.body as ExternalSession).startMs).toBe(754_000);
    expect(
      (await t.http('POST', `/browser-play/${browser.id}/external`, { token: tokenB, body: {} }))
        .status,
    ).toBe(404);
  });

  it('leaks no provider URL, key, release key or session id in responses or logs', async () => {
    const session = await started();
    await (await file(session.path)).arrayBuffer();
    const id = session.path.split('/')[2]!;
    await t.http('DELETE', `/browser-play/external/${id}`, { token });
    const logs = await t.http('GET', '/logs/app', { token });
    const everything = JSON.stringify([session.path, logs.body, t.logLines]);
    for (const secret of [SECRET, HASH, `127.0.0.1:${providerPort}`, 'torbox']) {
      expect(everything.replace(session.path, ''), secret).not.toContain(secret);
    }
    expect(t.logLines.join('\n')).not.toContain(id);
    expect(t.logLines.some((l) => l.includes('/api/media/***/file/'))).toBe(true);
    expect(t.logLines.some((l) => l.includes('/api/browser-play/external/***'))).toBe(true);
    const args = JSON.stringify(fake.processes.map((p) => p.args));
    expect(args).not.toContain(SECRET);
  });

  it('revoking the device ends its external session at once', async () => {
    const session = await started();
    const devices = (await t.http('GET', '/devices', { token })).body as {
      id: string;
      current: boolean;
    }[];
    const mine = devices.find((d) => d.current)!;
    expect((await t.http('DELETE', `/devices/${mine.id}`, { token: tokenB })).status).toBe(204);
    expect((await file(session.path)).status).toBe(404);
  });
});
