import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

const ID = 'jNQXAC9IVRw';
const PLUGIN = `plugin://plugin.video.youtube/play/?video_id=${ID}`;

const wait = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('wait timed out');
};

describe('POST /playback/youtube (e2e)', () => {
  let t: TestApp;
  let token: string;
  beforeEach(async () => {
    t = await createTestApp();
    token = await pairDevice(t);
    t.kodi.on('Player.GetActivePlayers', [{ playerid: 1 }]).on('Player.Seek', {});
  });
  afterEach(async () => {
    await t.close();
  });

  const opens = () => t.kodi.requests.filter((r) => r.method === 'Player.Open');
  const seeks = () => t.kodi.requests.filter((r) => r.method === 'Player.Seek');
  const post = (url: unknown, withToken = true) =>
    t.http('POST', '/playback/youtube', {
      ...(withToken ? { token } : {}),
      body: { url },
    });

  it('requires a token, and sends nothing to Kodi without one', async () => {
    expect((await post(`https://youtu.be/${ID}`, false)).status).toBe(401);
    expect(opens()).toHaveLength(0);
  });

  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
  ])('opens the fixed plugin URL for %s', async (url) => {
    const res = await post(url);
    expect(res).toEqual({ status: 202, body: { status: 'accepted' } });
    expect(opens()).toEqual([{ method: 'Player.Open', params: { item: { file: PLUGIN } } }]);
    expect(seeks()).toHaveLength(0);
  });

  it('seeks to t= only after Kodi reports that the video started', async () => {
    await post(`https://youtu.be/${ID}?t=1m30s`);
    expect(opens()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(seeks()).toHaveLength(0); // Player.Open said OK, nothing is playing yet

    t.kodi.notify('Player.OnAVStart', { data: { item: { type: 'unknown' } } });
    await wait(() => seeks().length === 1);
    expect(seeks()[0]?.params).toEqual({
      playerid: 1,
      value: { time: { hours: 0, minutes: 1, seconds: 30, milliseconds: 0 } },
    });

    // One seek per link: a later start (another video) must not seek again.
    t.kodi.notify('Player.OnAVStart', { data: { item: { type: 'unknown' } } });
    await new Promise((r) => setTimeout(r, 60));
    expect(seeks()).toHaveLength(1);
  });

  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/playlist?list=PLabcdefghijk123',
    'https://evil-youtube.com/watch?v=' + ID,
    'https://youtube.com.evil.net/watch?v=' + ID,
    'https://127.0.0.1:9090/',
    'http://192.168.1.1/',
    'https://example.com/a.mp4',
    'plugin://plugin.video.youtube/play/?video_id=' + ID,
    'plugin://plugin.video.youtube/?action=evil',
    'file:///etc/passwd',
    ID,
    'not a url',
  ])('rejects %j with 422 and sends nothing to Kodi', async (url) => {
    const res = await post(url);
    expect(res.status).toBe(422);
    expect(opens()).toHaveLength(0);
  });

  it.each([{}, { url: '' }, { url: 5 }, { url: 'x'.repeat(5000) }])(
    'rejects the body %j with 400',
    async (body) => {
      const res = await t.http('POST', '/playback/youtube', { token, body });
      expect(res.status).toBe(400);
      expect(opens()).toHaveLength(0);
    },
  );

  it('answers 503 when Kodi does not respond, and does not leave a seek waiting', async () => {
    t.kodi.setSilent(true);
    expect((await post(`https://youtu.be/${ID}?t=30`)).status).toBe(503);
    t.kodi.setSilent(false);
    t.kodi.notify('Player.OnAVStart', { data: {} });
    await new Promise((r) => setTimeout(r, 60));
    expect(seeks()).toHaveLength(0);
  });

  it('answers 502 when Kodi rejects the open (addon missing)', async () => {
    t.kodi.onCall('Player.Open', () => {
      throw new Error('Failed to execute method');
    });
    expect((await post(`https://youtu.be/${ID}`)).status).toBe(502);
  });
});
