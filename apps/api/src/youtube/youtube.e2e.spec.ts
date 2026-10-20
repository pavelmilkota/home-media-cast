import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

describe('/youtube/cast (e2e)', () => {
  let t: TestApp;
  let token: string;
  beforeEach(async () => {
    t = await createTestApp();
    token = await pairDevice(t);
  });
  afterEach(async () => {
    await t.close();
  });

  it('needs a device token for both reading and switching', async () => {
    expect((await t.http('GET', '/youtube/cast')).status).toBe(401);
    expect((await t.http('PUT', '/youtube/cast', { body: { enabled: true } })).status).toBe(401);
    expect(t.youtube.status().enabled).toBe(false);
  });

  it('is off by default', async () => {
    const res = await t.http('GET', '/youtube/cast', { token });
    expect(res).toEqual({
      status: 200,
      body: { enabled: false, running: false, deviceName: 'homeMediaCast' },
    });
  });

  it('switches on and off', async () => {
    const on = await t.http('PUT', '/youtube/cast', { token, body: { enabled: true } });
    expect(on.body).toMatchObject({ enabled: true, running: true });
    const off = await t.http('PUT', '/youtube/cast', { token, body: { enabled: false } });
    expect(off.body).toMatchObject({ enabled: false, running: false });
  });

  it.each([{}, { enabled: 'yes' }, { enabled: 1 }, []])('rejects the body %j', async (body) => {
    const res = await t.http('PUT', '/youtube/cast', { token, body });
    expect(res.status).toBe(400);
  });
});
