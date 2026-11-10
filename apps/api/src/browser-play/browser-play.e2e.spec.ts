import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  BrowserSession,
  DeviceCaps,
  LibraryResponse,
  PlaybackHistoryResponse,
  StreamsResponse,
} from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceService } from '../auth/device.service.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { createFakeSpawn, probeJson, type FakeSpawn } from './testing/fake-ffmpeg.js';

const SECRET = 'PROVIDER-SECRET-KEY';
const HASH = 'b'.repeat(40);
const ENV = [
  'AIOSTREAMS_URL',
  'AIOSTREAMS_UUID',
  'AIOSTREAMS_PASSWORD',
  'PLAYBACK_ALLOW_HOSTS',
  'CINEMETA_URL',
  'TRANSCODE',
  'TRANSCODE_HW_DECODE',
] as const;
const CAPS: DeviceCaps = {
  h264: true,
  hevc: false,
  hevc10: false,
  vp9: true,
  av1: false,
  hdr: false,
};

describe('browser playback (e2e)', () => {
  let t: TestApp;
  let token: string;
  let aio: Server;
  let provider: Server;
  let meta: Server;
  let providerPort: number;
  let providerHits: number;
  let fake: FakeSpawn;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    providerHits = 0;
    fake = createFakeSpawn();
    aio = createServer((_req, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          data: {
            results: [
              {
                url: `http://127.0.0.1:${providerPort}/movie.mkv?token=${SECRET}`,
                infoHash: HASH,
                filename: 'Movie.2023.1080p.mkv',
                service: 'torbox',
                cached: true,
              },
            ],
            errors: [],
          },
        }),
      ),
    );
    provider = createServer((req, res) => {
      providerHits++;
      if (new URL(req.url ?? '/', 'http://x').searchParams.get('token') !== SECRET) {
        return void res.writeHead(403).end();
      }
      res
        .writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1000' })
        .end(Buffer.from([0]));
    });
    meta = createServer((_req, res) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ meta: { id: 'tt0111161', name: 'The Movie', year: '1994' } })),
    );
    await Promise.all(
      [aio, provider, meta].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))),
    );
    providerPort = (provider.address() as AddressInfo).port;
    for (const k of ENV) saved[k] = process.env[k];
    process.env['CINEMETA_URL'] = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
    process.env['AIOSTREAMS_URL'] = `http://127.0.0.1:${(aio.address() as AddressInfo).port}`;
    process.env['AIOSTREAMS_UUID'] = 'uuid-1';
    process.env['AIOSTREAMS_PASSWORD'] = 'pw-1';
    t = await createTestApp(() => undefined, { spawn: fake.spawn });
    token = await pairDevice(t, 'Phone');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const s of [aio, provider, meta]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });

  const optionId = async () =>
    ((await t.http('GET', '/titles/movie/tt0111161/streams', { token })).body as StreamsResponse)
      .options[0]!.id;
  const start = async (over: Record<string, unknown> = {}, as = token) =>
    t.http('POST', '/browser-play', {
      token: as,
      body: { optionId: await optionId(), caps: CAPS, ...over },
    });
  const started = async (): Promise<BrowserSession> => {
    const res = await start();
    expect(res.status).toBe(201);
    return res.body as BrowserSession;
  };
  /** Pairing is throttled to one code per 10 s, so the second device is made directly. */
  const secondDevice = () => t.app.get(DeviceService).create('Laptop').token;
  const media = (path: string, init?: RequestInit) => fetch(`${t.base}${path}`, init);

  it('needs a device token for the control routes', async () => {
    expect((await t.http('POST', '/browser-play', { body: {} })).status).toBe(401);
    expect((await t.http('POST', '/browser-play/x/seek', { body: { positionMs: 1 } })).status).toBe(
      401,
    );
    expect((await t.http('DELETE', '/browser-play/x')).status).toBe(401);
  });

  it('rejects a malformed start', async () => {
    expect((await t.http('POST', '/browser-play', { token, body: { optionId: 'x' } })).status).toBe(
      400,
    );
    expect((await start({ caps: { h264: true } })).status).toBe(400);
    expect((await start({ extra: 1 })).status).toBe(400);
  });

  it('starts, serves the playlist without a token, serves segments, and ends', async () => {
    const session = await started();
    expect(session.run.playlistPath).toBe(`/media/${session.id}/1/index.m3u8`);

    // No Authorization header: the session id in the path is the capability.
    const playlist = await media(session.run.playlistPath);
    expect(playlist.status).toBe(200);
    expect(playlist.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(playlist.headers.get('cache-control')).toBe('no-store');
    expect(await playlist.text()).toMatch(/^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n/);

    const seg = await media(`/media/${session.id}/1/seg0.m4s`);
    expect(seg.status).toBe(200);
    expect(await seg.text()).toBe('seg0');
    expect((await media(`/media/${session.id}/1/init.mp4`)).status).toBe(200);
    const ranged = await media(`/media/${session.id}/1/seg0.m4s`, {
      headers: { range: 'bytes=1-2' },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('eg');

    expect((await t.http('DELETE', `/browser-play/${session.id}`, { token })).status).toBe(204);
    expect((await media(session.run.playlistPath)).status).toBe(404);
    expect(fake.ffmpeg().every((p) => p.signals.includes('SIGKILL'))).toBe(true);
  });

  it('saves progress to the library and history, and the next start resumes from it', async () => {
    const title = { type: 'movie', id: 'tt0111161' };
    const first = (await start({ title })).body as BrowserSession;
    expect(first.run.startMs).toBe(0);
    const post = (id: string, positionMs: unknown, as = token) =>
      t.http('POST', `/browser-play/${id}/progress`, { token: as, body: { positionMs } });
    expect((await post(first.id, 1_800_000)).status).toBe(204);
    expect((await post(first.id, -1)).status).toBe(400);
    expect((await post(first.id, 5, secondDevice())).status).toBe(404);

    const lib = (await t.http('GET', '/library', { token })).body as LibraryResponse;
    expect(lib.history[0]).toMatchObject({ id: 'tt0111161', videoId: 'tt0111161', watched: false });
    expect(lib.continueWatching).toHaveLength(1);
    const recent = (await t.http('GET', '/playback/history', { token }))
      .body as PlaybackHistoryResponse;
    expect(recent.items[0]).toMatchObject({ id: 'tt0111161' });

    const again = (await start({ title })).body as BrowserSession;
    expect(again.run.startMs).toBe(1_800_000);
    const fresh = (await start({ title, resume: false })).body as BrowserSession;
    expect(fresh.run.startMs).toBe(0);
    const explicit = (await start({ title, startMs: 90_000 })).body as BrowserSession;
    expect(explicit.run.startMs).toBe(90_000);
  });

  it('ignores progress for a play without catalog context', async () => {
    const session = await started();
    expect(
      (
        await t.http('POST', `/browser-play/${session.id}/progress`, {
          token,
          body: { positionMs: 1_800_000 },
        })
      ).status,
    ).toBe(204);
    const lib = (await t.http('GET', '/library', { token })).body as LibraryResponse;
    expect(lib.history).toHaveLength(0);
  });

  it('answers 404 for a bad file name, an unknown id, a wrong run and a non-number run', async () => {
    const session = await started();
    for (const path of [
      `/media/${session.id}/1/index.m3u8.bak`,
      `/media/${session.id}/1/seg0.m4s.tmp`,
      `/media/${session.id}/1/..%2Findex.m3u8`,
      `/media/${session.id}/1/passwd`,
      `/media/${session.id}/2/index.m3u8`,
      `/media/${session.id}/x/index.m3u8`,
      `/media/nope/1/index.m3u8`,
    ]) {
      expect((await media(path)).status, path).toBe(404);
    }
  });

  it("another device's session cannot be seeked or ended", async () => {
    const session = await started();
    const other = secondDevice();
    expect(
      (
        await t.http('POST', `/browser-play/${session.id}/seek`, {
          token: other,
          body: { positionMs: 5 },
        })
      ).status,
    ).toBe(404);
    expect((await t.http('DELETE', `/browser-play/${session.id}`, { token: other })).status).toBe(
      404,
    );
    expect((await media(session.run.playlistPath)).status).toBe(200);
  });

  it('a seek starts a new run and the old playlist stops being served', async () => {
    const session = await started();
    const res = await t.http('POST', `/browser-play/${session.id}/seek`, {
      token,
      body: { positionMs: 600_000 },
    });
    expect(res.status).toBe(200);
    const next = res.body as BrowserSession;
    expect(next.run).toMatchObject({ n: 2, startMs: 600_000 });
    expect((await media(session.run.playlistPath)).status).toBe(404);
    expect((await media(next.run.playlistPath)).status).toBe(200);
    expect(
      (
        await t.http('POST', `/browser-play/${session.id}/seek`, {
          token,
          body: { positionMs: -1 },
        })
      ).status,
    ).toBe(400);
  });

  it('a seek after the option id expired still starts a run, reading the same relay link', async () => {
    const id = await optionId();
    const first = await t.http('POST', '/browser-play', {
      token,
      body: { optionId: id, caps: CAPS },
    });
    const session = first.body as BrowserSession;
    // The option ids are good for 30 minutes; the film is longer.
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 31 * 60_000);
    expect(
      (await t.http('POST', '/browser-play', { token, body: { optionId: id, caps: CAPS } })).status,
    ).toBe(410);
    const hitsBefore = providerHits;
    const seeked = await t.http('POST', `/browser-play/${session.id}/seek`, {
      token,
      body: { positionMs: 3_600_000 },
    });
    expect(seeked.status).toBe(200);
    expect((seeked.body as BrowserSession).run.n).toBe(2);
    // No new link was asked of the provider: the new run reads the old run's relay entry.
    expect(providerHits).toBe(hitsBefore);
    const input = (n: number) => fake.ffmpeg()[n]?.args[fake.ffmpeg()[n]!.args.indexOf('-i') + 1];
    expect(input(1)).toBe(input(0));
  });

  it('answers 409 browser_unsupported for a video the device cannot play', async () => {
    fake.probe.json = probeJson({
      streams: [{ codec_type: 'video', codec_name: 'hevc', height: 2160, pix_fmt: 'yuv420p10le' }],
    });
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'browser_unsupported' });
    expect(fake.ffmpeg()).toHaveLength(0);
  });

  describe('conversion', () => {
    const hevc1080 = () =>
      probeJson({
        streams: [
          { codec_type: 'video', codec_name: 'hevc', height: 1080, pix_fmt: 'yuv420p10le' },
          { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng' } },
        ],
      });
    const restartWith = async (env: Record<string, string>) => {
      await t.close();
      Object.assign(process.env, env);
      t = await createTestApp(() => undefined, { spawn: fake.spawn });
      token = await pairDevice(t, 'Phone');
    };

    it('converts 1080p the device cannot decode, and says so', async () => {
      fake.probe.json = hevc1080();
      const session = (await start()).body as BrowserSession;
      expect(session.mode).toBe('transcode');
      const args = fake.ffmpeg().at(-1)?.args.join(' ') ?? '';
      expect(args).toContain('-c:v h264_vaapi');
      expect(args).toContain('format=nv12,hwupload');
    });

    it('uses libx264 for TRANSCODE=software and the GPU decoder when asked', async () => {
      fake.probe.json = hevc1080();
      await restartWith({ TRANSCODE: 'software' });
      await start();
      expect(fake.ffmpeg().at(-1)?.args.join(' ')).toContain('-c:v libx264');
      await restartWith({ TRANSCODE: 'vaapi', TRANSCODE_HW_DECODE: 'true' });
      await start();
      expect(fake.ffmpeg().at(-1)?.args.join(' ')).toContain('-hwaccel vaapi');
    });

    it('answers 409 browser_unsupported when TRANSCODE=off', async () => {
      fake.probe.json = hevc1080();
      await restartWith({ TRANSCODE: 'off' });
      const res = await start();
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'browser_unsupported' });
      expect(fake.ffmpeg()).toHaveLength(0);
    });

    it('still copies what the device decodes when TRANSCODE=off', async () => {
      await restartWith({ TRANSCODE: 'off' });
      expect(((await start()).body as BrowserSession).mode).toBe('copy');
    });
  });

  describe('audio and subtitles', () => {
    const tracks = () =>
      probeJson({
        streams: [
          { codec_type: 'video', codec_name: 'h264', height: 1080 },
          { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'ukr' } },
          { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } },
          { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
          { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
          { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'pol' } },
        ],
      });
    const post = (id: string, path: string, body: unknown, as = token) =>
      t.http('POST', `/browser-play/${id}/${path}`, { token: as, body });

    it('lists text subtitles only and writes them from the same read', async () => {
      fake.probe.json = tracks();
      const session = (await start()).body as BrowserSession;
      expect(session.subtitleTracks.map((s) => s.language)).toEqual(['eng', 'pol']);
      expect(session.subtitleTracks[0]).not.toHaveProperty('streamIndex');
      const args = fake.ffmpeg().at(-1)?.args.join(' ') ?? '';
      expect(args).toContain('-map 0:s:1 -c:s webvtt -flush_packets 1 -f webvtt sub0.vtt');
      expect(args).toContain('-map 0:s:2 -c:s webvtt -flush_packets 1 -f webvtt sub1.vtt');
      expect(args).not.toContain('0:s:0');
      expect((await media(`/media/${session.id}/1/sub0.vtt`)).status).toBe(404); // not written yet
    });

    it('an audio change starts a new run at the same position', async () => {
      fake.probe.json = tracks();
      const session = (await start()).body as BrowserSession;
      expect(session.audioIndex).toBe(0);
      const res = await post(session.id, 'audio', { index: 1, positionMs: 754_000 });
      expect(res.status).toBe(200);
      const next = res.body as BrowserSession;
      expect(next.audioIndex).toBe(1);
      expect(next.run).toMatchObject({ n: 2, startMs: 754_000 });
      expect(fake.ffmpeg().at(-1)?.args.join(' ')).toContain('-map 0:a:1');
      expect((await media(session.run.playlistPath)).status).toBe(404);
      expect((await media(next.run.playlistPath)).status).toBe(200);
    });

    it('refuses an audio change for a missing track, a bad body or another device', async () => {
      fake.probe.json = tracks();
      const session = (await start()).body as BrowserSession;
      expect((await post(session.id, 'audio', { index: 9 })).status).toBe(400);
      expect((await post(session.id, 'audio', { index: -1 })).status).toBe(400);
      expect((await post(session.id, 'audio', { index: 1 }, secondDevice())).status).toBe(404);
      expect((await post(session.id, 'subtitle', { index: 9 })).status).toBe(400);
      expect((await post(session.id, 'subtitle', { index: 0 }, secondDevice())).status).toBe(404);
    });

    it('remembers the language for the next file, and shows the remembered subtitle', async () => {
      fake.probe.json = tracks();
      const first = (await start()).body as BrowserSession;
      expect(first.subtitleIndex).toBeUndefined();
      await post(first.id, 'audio', { index: 1 });
      expect((await post(first.id, 'subtitle', { index: 1 })).status).toBe(204);
      const second = (await start()).body as BrowserSession;
      expect(second.audioIndex).toBe(1);
      expect(second.subtitleIndex).toBe(1);
      expect(fake.ffmpeg().at(-1)?.args.join(' ')).toContain('-map 0:a:1');
      await post(second.id, 'subtitle', { index: null });
      expect(((await start()).body as BrowserSession).subtitleIndex).toBeUndefined();
    });
  });

  it('answers 410 for an unknown option id', async () => {
    expect((await start({ optionId: 'nope' })).status).toBe(410);
  });

  it('leaks no provider URL, key, release key or relay id in responses or logs', async () => {
    const session = await started();
    const seeked = await t.http('POST', `/browser-play/${session.id}/seek`, {
      token,
      body: { positionMs: 5000 },
    });
    const playlist = await (await media(session.run.playlistPath)).text();
    const logs = await t.http('GET', '/logs/app', { token });
    const everything = JSON.stringify([session, seeked.body, playlist, logs.body, t.logLines]);
    for (const secret of [SECRET, HASH, '127.0.0.1:' + providerPort, 'torbox']) {
      expect(everything, secret).not.toContain(secret);
    }
    // The session id is a capability: it is in the paths clients use, never in a log line.
    expect(everything.split(session.id).length - 1).toBe(
      // the session body, the seeked body and the playlist path inside both bodies
      (JSON.stringify([session, seeked.body]).match(new RegExp(session.id, 'g')) ?? []).length,
    );
    expect(t.logLines.join('\n')).not.toContain(session.id);
    expect(t.logLines.some((l) => l.includes('/api/media/***/1/index.m3u8'))).toBe(true);
    expect(t.logLines.some((l) => l.includes('/api/browser-play/***/seek'))).toBe(true);
    // Neither process was given the provider link or its key.
    const args = JSON.stringify(fake.processes.map((p) => p.args));
    expect(args).not.toContain(SECRET);
    expect(args).not.toContain('provider');
  });

  it('gives ffmpeg a minimal environment, without the AIOStreams password', async () => {
    await started();
    for (const p of fake.processes) {
      expect(Object.keys(p.options.env).sort()).toEqual(['LANG', 'PATH']);
    }
  });

  it('revoking the device ends its session at once', async () => {
    const session = await started();
    const other = secondDevice();
    const mine = (
      (await t.http('GET', '/devices', { token })).body as { id: string; current: boolean }[]
    ).find((d) => d.current)!;
    expect((await t.http('DELETE', `/devices/${mine.id}`, { token: other })).status).toBe(204);
    await vi.waitFor(async () => expect((await media(session.run.playlistPath)).status).toBe(404));
    expect(fake.ffmpeg()[0]?.signals).toContain('SIGKILL');
    expect(
      (await t.http('POST', `/browser-play/${session.id}/seek`, { token, body: { positionMs: 1 } }))
        .status,
    ).toBe(401);
  });

  it('stopping the API kills ffmpeg and removes the files', async () => {
    const session = await started();
    const runDir = fake.ffmpeg()[0]?.options.cwd as string;
    expect(existsSync(runDir)).toBe(true);
    await t.app.close();
    expect(fake.ffmpeg()[0]?.signals).toContain('SIGKILL');
    expect(existsSync(runDir)).toBe(false);
    void session;
  });

  it("another device's copy play runs alongside: nothing ends when it plays", async () => {
    const first = await started();
    const confirm = (id: string, as: string) =>
      t.http('POST', `/browser-play/${id}/started`, { token: as });
    expect((await confirm(first.id, token)).status).toBe(204);

    const other = secondDevice();
    const second = (await start({}, other)).body as BrowserSession;
    expect(second.mode).toBe('copy');
    expect((await confirm(second.id, token)).status).toBe(404); // not this device's session
    expect((await confirm(second.id, other)).status).toBe(204);
    expect((await media(first.run.playlistPath)).status).toBe(200);
    expect((await media(second.run.playlistPath)).status).toBe(200);
  });

  it('a converted play ends another converted one when it reports it plays, not before; a copy play stays', async () => {
    const copy = await started();
    const confirm = (id: string, as: string) =>
      t.http('POST', `/browser-play/${id}/started`, { token: as });
    expect((await confirm(copy.id, token)).status).toBe(204);

    fake.probe.json = probeJson({
      streams: [
        { codec_type: 'video', codec_name: 'hevc', height: 1080, pix_fmt: 'yuv420p10le' },
        { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng' } },
      ],
    });
    const third = secondDevice();
    const first = (await start({}, third)).body as BrowserSession;
    expect((await confirm(first.id, third)).status).toBe(204);
    const other = secondDevice();
    const second = (await start({}, other)).body as BrowserSession;
    expect(second.mode).toBe('transcode');
    expect((await media(first.run.playlistPath)).status).toBe(200); // still playing
    expect((await confirm(second.id, other)).status).toBe(204);
    expect((await media(first.run.playlistPath)).status).toBe(404);
    expect((await media(second.run.playlistPath)).status).toBe(200);
    expect((await media(copy.run.playlistPath)).status).toBe(200);
  });

  it('a device starting again replaces its own session at once', async () => {
    const first = await started();
    expect((await start()).status).toBe(201);
    expect((await media(first.run.playlistPath)).status).toBe(404);
  });
});
