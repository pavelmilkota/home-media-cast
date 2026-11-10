import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppLogResponse, KodiLogResponse } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

describe('Logs (e2e)', () => {
  let t: TestApp;
  let token: string;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmc-logs-'));
    const lines = Array.from({ length: 700 }, (_, i) => `line ${i}`);
    lines.push(
      'WARNING <general>: CFileCache - <http://127.0.0.1:8787/api/relay/RELAYID123/a.mkv?token=SECRET>',
    );
    writeFileSync(join(dir, 'kodi.log'), lines.join('\n') + '\n');
    t = await createTestApp(undefined, { kodiLogDir: dir });
    token = await pairDevice(t);
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires a token', async () => {
    for (const path of ['/logs/app', '/logs/kodi']) {
      expect((await t.http('GET', path)).status, path).toBe(401);
    }
  });

  it('lists warnings and errors from the app, without secrets', async () => {
    const log = new Logger('RelayService');
    log.log('request line, not kept');
    log.warn('Relay request failed: Upstream unreachable');
    log.error('GET /x?token=SECRET exploded');
    const res = await t.http('GET', '/logs/app', { token });
    expect(res.status).toBe(200);
    const { entries } = res.body as AppLogResponse;
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error']);
    expect(entries[0]).toMatchObject({
      context: 'RelayService',
      message: 'Relay request failed: Upstream unreachable',
    });
    expect(JSON.stringify(entries)).not.toContain('SECRET');
  });

  it('returns the Kodi tail redacted, defaulting to 500 lines', async () => {
    const res = await t.http('GET', '/logs/kodi', { token });
    expect(res.status).toBe(200);
    const body = res.body as KodiLogResponse;
    expect(body).toMatchObject({ available: true, truncated: true });
    expect(body.lines).toHaveLength(500);
    expect(body.lines.at(-1)).toBe(
      'WARNING <general>: CFileCache - <http://127.0.0.1:8787/api/relay/***/a.mkv?token=***>',
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('RELAYID123');
  });

  it('honours and clamps ?lines, and rejects a non-integer', async () => {
    const some = await t.http('GET', '/logs/kodi?lines=3', { token });
    expect((some.body as KodiLogResponse).lines).toHaveLength(3);
    const big = await t.http('GET', '/logs/kodi?lines=99999', { token });
    expect((big.body as KodiLogResponse).lines).toHaveLength(500);
    expect((await t.http('GET', '/logs/kodi?lines=abc', { token })).status).toBe(400);
  });

  it('says the Kodi log is unavailable when no directory is configured', async () => {
    const bare = await createTestApp();
    try {
      const tk = await pairDevice(bare);
      const res = await bare.http('GET', '/logs/kodi', { token: tk });
      expect(res.body).toEqual({ available: false, lines: [], truncated: false });
    } finally {
      await bare.close();
    }
  });
});
