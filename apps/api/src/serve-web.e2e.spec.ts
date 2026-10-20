import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './testing/test-app.js';

describe('serving the built web UI (e2e)', () => {
  let t: TestApp;
  let origin: string;
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmc-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>PWA</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    t = await createTestApp(() => undefined, { webDir: dir });
    origin = t.base.replace(/\/api$/, '');
  });
  afterEach(async () => {
    await t.close();
  });

  it('serves index.html at / without caching it', async () => {
    const res = await fetch(`${origin}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>PWA</title>');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves assets', async () => {
    const res = await fetch(`${origin}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
  });

  it('falls back to index.html for client-side paths', async () => {
    expect(await (await fetch(`${origin}/devices`)).text()).toContain('<title>PWA</title>');
  });

  it('never shadows the API', async () => {
    const health = await fetch(`${origin}/api/health`);
    expect(health.headers.get('content-type')).toContain('application/json');
    expect((await fetch(`${origin}/api/devices`)).status).toBe(401);
    expect((await fetch(`${origin}/api/docs-json`)).status).toBe(200);
  });

  it('does not answer non-GET requests with the page', async () => {
    expect((await fetch(`${origin}/anything`, { method: 'POST' })).status).toBe(404);
  });
});
