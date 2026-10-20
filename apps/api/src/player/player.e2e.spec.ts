import type { PlayerStatus } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, readSse, type TestApp } from '../testing/test-app.js';

const PLAYING = [{ playerid: 1, playertype: 'internal', type: 'video' }];
const time = (s: number) => ({ hours: 0, minutes: 0, seconds: s, milliseconds: 0 });

describe('player API (e2e)', () => {
  let t: TestApp;
  let token: string;
  let positionS: number;
  let speed: number;

  beforeEach(async () => {
    positionS = 10;
    speed = 1;
    t = await createTestApp((kodi) => {
      kodi
        .on('JSONRPC.Version', { version: { major: 13, minor: 5, patch: 0 } })
        .on('Application.GetProperties', { volume: 40, muted: false })
        .onCall('Player.GetActivePlayers', () => (speed === -1 ? [] : PLAYING))
        .onCall('Player.GetProperties', () => ({
          speed,
          time: time(positionS),
          totaltime: time(100),
          audiostreams: [
            { index: 0, name: 'AC3', language: 'eng' },
            { index: 1, name: 'AAC', language: 'rus' },
          ],
          currentaudiostream: { index: 0, language: 'eng' },
          subtitles: [{ index: 0, name: 'SRT', language: 'eng' }],
          currentsubtitle: null,
          subtitleenabled: false,
        }))
        .on('Player.GetItem', { item: { label: 'movie.mkv', type: 'unknown' } });
    });
    token = await pairDevice(t);
  });
  afterEach(async () => {
    await t.close();
  });

  const calls = (method: string) => t.kodi.requests.filter((r) => r.method === method);
  const post = (path: string, body?: unknown) => t.http('POST', path, { token, body });

  it('requires a token on every route and sends nothing to Kodi (criterion #7)', async () => {
    const before = t.kodi.requests.length;
    for (const [method, path] of [
      ['GET', '/player/status'],
      ['GET', '/events'],
      ['POST', '/player/pause'],
      ['POST', '/player/resume'],
      ['POST', '/player/stop'],
      ['POST', '/player/seek'],
      ['POST', '/player/volume'],
      ['POST', '/player/audio'],
      ['POST', '/player/subtitle'],
    ] as const) {
      expect((await t.http(method, path)).status, `${method} ${path}`).toBe(401);
    }
    expect(t.kodi.requests.length).toBe(before);
  });

  it('reports the status', async () => {
    const res = await t.http('GET', '/player/status', { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      active: true,
      title: 'movie.mkv',
      positionMs: 10_000,
      durationMs: 100_000,
      volume: 40,
      currentAudioStream: 0,
    });
  });

  it('pause, resume and stop reach Kodi (criterion #5)', async () => {
    expect((await post('/player/pause')).status).toBe(204);
    expect(calls('Player.PlayPause').at(-1)?.params).toEqual({ playerid: 1, play: false });
    expect((await post('/player/resume')).status).toBe(204);
    expect(calls('Player.PlayPause').at(-1)?.params).toEqual({ playerid: 1, play: true });
    expect((await post('/player/stop')).status).toBe(204);
    expect(calls('Player.Stop')).toHaveLength(1);
  });

  it('seeks by position, percentage and offset', async () => {
    expect((await post('/player/seek', { positionMs: 5000 })).status).toBe(204);
    expect((await post('/player/seek', { percentage: 50 })).status).toBe(204);
    expect((await post('/player/seek', { offsetSeconds: -30 })).status).toBe(204);
    expect(calls('Player.Seek').map((c) => c.params)).toEqual([
      { playerid: 1, value: { time: { hours: 0, minutes: 0, seconds: 5, milliseconds: 0 } } },
      { playerid: 1, value: { percentage: 50 } },
      { playerid: 1, value: { seconds: -30 } },
    ]);
  });

  it('sets volume, audio track and subtitles (criterion #9)', async () => {
    expect((await post('/player/volume', { volume: 70 })).status).toBe(204);
    expect(calls('Application.SetVolume').at(-1)?.params).toEqual({ volume: 70 });
    expect((await post('/player/audio', { index: 1 })).status).toBe(204);
    expect(calls('Player.SetAudioStream').at(-1)?.params).toEqual({ playerid: 1, stream: 1 });
    expect((await post('/player/subtitle', { index: 0 })).status).toBe(204);
    expect(calls('Player.SetSubtitle').at(-1)?.params).toEqual({
      playerid: 1,
      subtitle: 0,
      enable: true,
    });
    expect((await post('/player/subtitle', { index: 'off' })).status).toBe(204);
    expect(calls('Player.SetSubtitle').at(-1)?.params).toEqual({ playerid: 1, subtitle: 'off' });
  });

  it.each([
    ['/player/volume', { volume: 101 }],
    ['/player/volume', { volume: -1 }],
    ['/player/volume', { volume: 5.5 }],
    ['/player/volume', {}],
    ['/player/seek', {}],
    ['/player/seek', { percentage: 101 }],
    ['/player/seek', { positionMs: -1 }],
    ['/player/seek', { positionMs: 1, percentage: 1 }],
    ['/player/audio', { index: -1 }],
    ['/player/subtitle', { index: 'on' }],
    ['/player/subtitle', { index: 'off', extra: 1 }],
  ])('rejects %s %j with 400 and leaves Kodi alone', async (path, body) => {
    const before = t.kodi.requests.length;
    expect((await post(path, body)).status).toBe(400);
    expect(t.kodi.requests.length).toBe(before);
  });

  it('answers 409 when nothing is playing', async () => {
    speed = -1; // fake: no active players
    for (const path of ['/player/pause', '/player/resume', '/player/stop']) {
      const res = await post(path);
      expect(res.status, path).toBe(409);
      expect(res.body).toMatchObject({ error: 'nothing_playing' });
    }
    const status = await t.http('GET', '/player/status', { token });
    expect(status.body).toMatchObject({ active: false, volume: 40 });
  });

  describe('SSE /events', () => {
    it('sends the Kodi state and the current status on connect', async () => {
      const events = await readSse(t, token, 2);
      expect(events.map((e) => e.event)).toEqual(['kodi', 'status']);
      expect(events[0]!.data).toMatchObject({ state: 'connected', version: '13.5.0' });
    });

    it('pushes a status change right after a Kodi notification, without polling the API', async () => {
      const reading = readSse(t, token, 0, {
        until: (ev) =>
          ev.some(
            (e) =>
              e.event === 'status' &&
              (e.data as PlayerStatus).active &&
              (e.data as { speed: number }).speed === 0,
          ),
      });
      await new Promise((r) => setTimeout(r, 150));
      speed = 0;
      t.kodi.notify('Player.OnPause', { data: {}, sender: 'xbmc' });
      const events = await reading;
      const last = events.at(-1)!.data as { speed: number };
      expect(last.speed).toBe(0);
    });

    it('polls the position while playing, and stops polling while paused', async () => {
      const reading = readSse(t, token, 0, {
        timeoutMs: 4000,
        until: (ev) => ev.filter((e) => e.event === 'status').length >= 4,
      });
      const ticker = setInterval(() => (positionS += 1), 30);
      const events = await reading;
      clearInterval(ticker);
      const positions = events
        .filter((e) => e.event === 'status')
        .map((e) => (e.data as { positionMs: number }).positionMs);
      expect(new Set(positions).size).toBeGreaterThanOrEqual(3);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));

      speed = 0;
      t.kodi.notify('Player.OnPause', {});
      await new Promise((r) => setTimeout(r, 200));
      const before = calls('Player.GetProperties').length;
      await new Promise((r) => setTimeout(r, 300));
      expect(calls('Player.GetProperties').length - before).toBeLessThanOrEqual(1);
    });

    it('reports Kodi going away', async () => {
      const reading = readSse(t, token, 0, {
        until: (ev) =>
          ev.some(
            (e) => e.event === 'kodi' && (e.data as { state: string }).state === 'unreachable',
          ),
      });
      await new Promise((r) => setTimeout(r, 100));
      await t.kodi.stop();
      const events = await reading;
      expect(
        events.some(
          (e) => e.event === 'kodi' && (e.data as { state: string }).state === 'reconnecting',
        ),
      ).toBe(true);
    });
  });
});
