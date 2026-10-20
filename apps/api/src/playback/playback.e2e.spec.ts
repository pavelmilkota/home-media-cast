import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

describe('POST /playback (e2e)', () => {
  let t: TestApp;
  let token: string;
  beforeEach(async () => {
    t = await createTestApp();
    token = await pairDevice(t);
  });
  afterEach(async () => {
    await t.close();
  });

  const opens = () => t.kodi.requests.filter((r) => r.method === 'Player.Open');

  it('requires a token, and sends nothing to Kodi without one (criterion #7)', async () => {
    const res = await t.http('POST', '/playback', {
      body: { kind: 'direct_url', url: 'http://93.184.216.34/a.mp4' },
    });
    expect(res.status).toBe(401);
    expect(opens()).toHaveLength(0);
  });

  it('passes a public link to Kodi', async () => {
    const res = await t.http('POST', '/playback', {
      token,
      body: { kind: 'direct_url', url: 'http://93.184.216.34/a.mp4', resume: true },
    });
    expect(res.status).toBe(202);
    expect(opens()).toEqual([
      {
        method: 'Player.Open',
        params: { item: { file: 'http://93.184.216.34/a.mp4' }, options: { resume: true } },
      },
    ]);
  });

  it.each([
    'http://127.0.0.1:9090',
    'http://192.168.1.10:3000',
    'http://100.101.102.103/',
    'file:///etc/passwd',
  ])('answers 422 for %s and sends nothing to Kodi (criterion #8)', async (url) => {
    const res = await t.http('POST', '/playback', { token, body: { kind: 'direct_url', url } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'url_rejected' });
    expect(opens()).toHaveLength(0);
  });

  it.each([
    {},
    { kind: 'direct_url' },
    { kind: 'torrent', url: 'http://93.184.216.34/' },
    { kind: 'direct_url', url: 5 },
  ])('answers 400 for malformed body %j', async (body) => {
    expect((await t.http('POST', '/playback', { token, body })).status).toBe(400);
  });

  it('maps a Kodi JSON-RPC error to 502 and a later request still works', async () => {
    let first = true;
    t.kodi.onCall('Player.Open', () => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
      return 'OK';
    });
    const body = { kind: 'direct_url', url: 'http://93.184.216.34/a.mp4' };
    const failed = await t.http('POST', '/playback', { token, body });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ error: 'kodi_error' });
    expect((await t.http('POST', '/playback', { token, body })).status).toBe(202);
  });

  // Recorded from real Kodi 21.3: a link that 404s is accepted by Player.Open ("OK"), then
  // Kodi sends Player.OnPlay and Player.OnStop ~100 ms later and never Player.OnAVStart.
  it('a broken link is accepted (202) and never becomes active; a retry then plays (criterion #6)', async () => {
    let playing = false;
    let attempt = 0;
    t.kodi
      .onCall('Player.GetActivePlayers', () =>
        playing ? [{ playerid: 1, playertype: 'internal', type: 'video' }] : [],
      )
      .on('Application.GetProperties', { volume: 40, muted: false })
      .onCall('Player.Open', () => {
        attempt += 1;
        if (attempt === 1) {
          setTimeout(() => {
            t.kodi.notify('Player.OnPlay', {});
            t.kodi.notify('Player.OnStop', {});
          }, 20);
        } else {
          playing = true;
        }
        return 'OK';
      })
      .onCall('Player.GetProperties', () => ({
        speed: 1,
        time: { hours: 0, minutes: 0, seconds: 1, milliseconds: 0 },
        totaltime: { hours: 0, minutes: 1, seconds: 0, milliseconds: 0 },
        audiostreams: [],
        currentaudiostream: null,
        subtitles: [],
        currentsubtitle: null,
        subtitleenabled: false,
      }))
      .on('Player.GetItem', { item: { label: 'b.mp4', type: 'unknown' } });

    const first = await t.http('POST', '/playback', {
      token,
      body: { kind: 'direct_url', url: 'http://93.184.216.34/broken.mp4' },
    });
    expect(first.status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect((await t.http('GET', '/player/status', { token })).body).toMatchObject({
      active: false,
    });

    const retry = await t.http('POST', '/playback', {
      token,
      body: { kind: 'direct_url', url: 'http://93.184.216.34/b.mp4' },
    });
    expect(retry.status).toBe(202);
    expect((await t.http('GET', '/player/status', { token })).body).toMatchObject({
      active: true,
      title: 'b.mp4',
    });
  });

  it('answers 503 and stays alive when Kodi is gone (criterion #3)', async () => {
    await t.kodi.stop();
    for (let i = 0; i < 100; i++) {
      const h = (await t.http('GET', '/health')).body as { kodi: { state: string } };
      if (h.kodi.state !== 'connected') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const res = await t.http('POST', '/playback', {
      token,
      body: { kind: 'direct_url', url: 'http://93.184.216.34/a.mp4' },
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'kodi_unavailable' });
    const health = await t.http('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'degraded' });
  });
});
