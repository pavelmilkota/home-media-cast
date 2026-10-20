import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../auth/tokens.js';
import { DbService } from '../db/db.service.js';
import { devices } from '../db/schema.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

describe('pairing and auth (e2e)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const shownCode = (): string =>
    /\d{6}/.exec(
      JSON.stringify(t.kodi.requests.findLast((r) => r.method === 'GUI.ShowNotification')?.params),
    )![0];

  it('rejects a request with no token and does not touch Kodi (criterion #7)', async () => {
    const before = t.kodi.requests.length;
    expect((await t.http('GET', '/devices')).status).toBe(401);
    expect((await t.http('GET', '/devices', { token: 'garbage' })).status).toBe(401);
    expect(t.kodi.requests.length).toBe(before);
  });

  it('keeps /health public', async () => {
    expect((await t.http('GET', '/health')).status).toBe(200);
  });

  it('shows the code on Kodi only, never in the HTTP response', async () => {
    const res = await t.http('POST', '/pairing/start');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(shownCode());
  });

  it('pairs a device, lists it, and revokes it', async () => {
    const token = await pairDevice(t, 'Pixel');
    const list = await t.http('GET', '/devices', { token });
    expect(list.status).toBe(200);
    const [device] = list.body as { id: string; name: string; current: boolean }[];
    expect(device).toMatchObject({ name: 'Pixel', current: true });

    expect((await t.http('DELETE', `/devices/${device!.id}`, { token })).status).toBe(204);
    expect((await t.http('GET', '/devices', { token })).status).toBe(401);
  });

  it('stores only the hash of the token', async () => {
    const token = await pairDevice(t);
    const rows = t.app.get(DbService).orm.select().from(devices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('a code works once', async () => {
    await t.http('POST', '/pairing/start');
    const code = shownCode();
    const body = { code, deviceName: 'A' };
    expect((await t.http('POST', '/pairing/complete', { body })).status).toBe(200);
    expect((await t.http('POST', '/pairing/complete', { body })).status).toBe(401);
  });

  it('cancels the code after 5 wrong guesses, even if the next one is right', async () => {
    await t.http('POST', '/pairing/start');
    const right = shownCode();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect(
        (await t.http('POST', '/pairing/complete', { body: { code: wrong, deviceName: 'x' } }))
          .status,
      ).toBe(401);
    }
    const last = await t.http('POST', '/pairing/complete', {
      body: { code: right, deviceName: 'x' },
    });
    expect(last.status).toBe(401);
  });

  it('throttles repeated /pairing/start calls', async () => {
    expect((await t.http('POST', '/pairing/start')).status).toBe(200);
    expect((await t.http('POST', '/pairing/start')).status).toBe(429);
  });

  it.each([
    [{ code: '12345', deviceName: 'x' }],
    [{ code: 'abcdef', deviceName: 'x' }],
    [{ code: '123456', deviceName: '' }],
    [{ code: '123456' }],
    [{}],
  ])('rejects malformed body %j with 400', async (body) => {
    expect((await t.http('POST', '/pairing/complete', { body })).status).toBe(400);
  });
});

describe('pairing when Kodi is down (e2e)', () => {
  it('answers 503, not a code nobody can see', async () => {
    const t = await createTestApp(() => undefined, { startKodi: false });
    await t.kodi.stop();
    const res = await t.http('POST', '/pairing/start');
    expect(res.status).toBe(503);
    expect(
      (await t.http('POST', '/pairing/complete', { body: { code: '000000', deviceName: 'x' } }))
        .status,
    ).toBe(401);
    await t.app.close();
  });
});
