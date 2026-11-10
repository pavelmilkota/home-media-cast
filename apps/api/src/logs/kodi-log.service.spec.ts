import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KodiLogService } from './kodi-log.service.js';

describe('KodiLogService', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hmc-kodilog-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (text: string) => writeFileSync(join(dir, 'kodi.log'), text);

  it('is unavailable without a directory or a file', async () => {
    expect(await new KodiLogService(undefined).tail(10)).toEqual({
      available: false,
      lines: [],
      truncated: false,
    });
    expect((await new KodiLogService(dir).tail(10)).available).toBe(false);
  });

  it('returns the last N lines, redacted', async () => {
    write('a\nb\nGET /x?token=SECRET\nd\n');
    const res = await new KodiLogService(dir).tail(3);
    expect(res).toEqual({
      available: true,
      lines: ['b', 'GET /x?token=***', 'd'],
      truncated: true,
    });
  });

  it('is not truncated when everything fits; an empty file has no lines', async () => {
    write('one\ntwo');
    expect(await new KodiLogService(dir).tail(10)).toEqual({
      available: true,
      lines: ['one', 'two'],
      truncated: false,
    });
    write('');
    expect(await new KodiLogService(dir).tail(10)).toEqual({
      available: true,
      lines: [],
      truncated: false,
    });
  });

  it('clamps the line count to 1..500', async () => {
    write(Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n'));
    const svc = new KodiLogService(dir);
    expect((await svc.tail(10_000)).lines).toHaveLength(500);
    expect((await svc.tail(0)).lines).toHaveLength(1);
    expect((await svc.tail(-5)).lines).toEqual(['l599']);
  });

  it('reads only the end of a file bigger than the chunk and drops the partial first line', async () => {
    const line = 'x'.repeat(99) + '\n';
    write(line.repeat(10_000) + 'last\n');
    const res = await new KodiLogService(dir).tail(500);
    expect(res.truncated).toBe(true);
    expect(res.lines.at(-1)).toBe('last');
    expect(res.lines.every((l) => l === 'last' || l.length === 99)).toBe(true);
  });
});
