import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { KodiRestartService } from './kodi-restart.service.js';

describe('TV controls (e2e)', () => {
  let t: TestApp;
  let token: string;
  let dir: string;
  let clock: number;
  let trigger: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmc-tv-'));
    trigger = join(dir, 'kodi-restart');
    clock = 1_000_000;
    t = await createTestApp(undefined, { restart: new KodiRestartService(trigger, () => clock) });
    token = await pairDevice(t);
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const calls = (method: string) => t.kodi.requests.filter((r) => r.method === method);
  const post = (path: string) => t.http('POST', path, { token });

  it('requires a token and sends nothing to Kodi or the disk', async () => {
    const before = t.kodi.requests.length;
    for (const path of ['/tv/fullscreen', '/tv/home', '/tv/screensaver', '/tv/restart-kodi']) {
      expect((await t.http('POST', path)).status, path).toBe(401);
    }
    expect(t.kodi.requests.length).toBe(before);
    expect(() => readFileSync(trigger)).toThrow();
  });

  it('toggles fullscreen and opens the home window', async () => {
    expect((await post('/tv/fullscreen')).status).toBe(204);
    expect(calls('GUI.SetFullscreen').at(-1)?.params).toEqual({ fullscreen: 'toggle' });
    expect((await post('/tv/home')).status).toBe(204);
    expect(calls('GUI.ActivateWindow').at(-1)?.params).toEqual({ window: 'home' });
  });

  it('starts the screensaver', async () => {
    expect((await post('/tv/screensaver')).status).toBe(204);
    expect(calls('GUI.ActivateScreenSaver')).toHaveLength(1);
  });

  it('answers 202 and leaves an empty trigger file for the host', async () => {
    const res = await post('/tv/restart-kodi');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'requested' });
    expect(readFileSync(trigger, 'utf8')).toBe('');
  });

  it('allows one restart request per 30 seconds', async () => {
    expect((await post('/tv/restart-kodi')).status).toBe(202);
    clock += 29_000;
    const early = await post('/tv/restart-kodi');
    expect(early.status).toBe(429);
    expect(early.body).toMatchObject({ error: 'restart_rate_limited' });
    clock += 1_000;
    expect((await post('/tv/restart-kodi')).status).toBe(202);
  });

  it('says so when the trigger cannot be written, and does not use up the cool-down', async () => {
    const blocked = await createTestApp(undefined, {
      restart: new KodiRestartService(join(dir, 'missing', 'kodi-restart'), () => clock),
    });
    try {
      const tk = await pairDevice(blocked);
      const first = await blocked.http('POST', '/tv/restart-kodi', { token: tk });
      expect(first.status).toBe(503);
      expect(first.body).toMatchObject({ error: 'restart_unavailable' });
      const again = await blocked.http('POST', '/tv/restart-kodi', { token: tk });
      expect(again.status).toBe(503); // not 429
    } finally {
      await blocked.close();
    }
  });

  it('is unavailable when no trigger path is configured', async () => {
    const bare = await createTestApp();
    try {
      const tk = await pairDevice(bare);
      expect((await bare.http('POST', '/tv/restart-kodi', { token: tk })).status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
