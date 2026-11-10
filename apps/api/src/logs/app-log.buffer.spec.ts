import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogBuffer } from './app-log.buffer.js';

describe('AppLogBuffer', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('records warnings and errors, oldest first, and ignores the other levels', () => {
    const buf = new AppLogBuffer();
    buf.log('request line', 'HTTP');
    buf.debug('noise');
    buf.warn('Relay request failed: Upstream unreachable', 'RelayService');
    buf.error('boom', 'at x\n    at y', 'KodiService');
    buf.fatal('dead', 'Main');
    const entries = buf.entries();
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error', 'error']);
    expect(entries[0]).toMatchObject({
      context: 'RelayService',
      message: 'Relay request failed: Upstream unreachable',
    });
    expect(entries[1]?.context).toBe('KodiService');
    expect(entries[1]?.message).toContain('boom');
    expect(entries[1]?.message).toContain('    at y');
    expect(new Date(entries[0]!.time).toISOString()).toBe(entries[0]!.time);
  });

  it('keeps only the newest entries when full', () => {
    const buf = new AppLogBuffer(3);
    for (let i = 1; i <= 5; i++) buf.warn(`w${i}`);
    expect(buf.entries().map((e) => e.message)).toEqual(['w3', 'w4', 'w5']);
  });

  it('redacts before storing', () => {
    const buf = new AppLogBuffer();
    buf.warn('GET /x?token=SECRET failed', 'HTTP');
    buf.error(new Error('Authorization: Bearer SECRET'));
    expect(JSON.stringify(buf.entries())).not.toContain('SECRET');
  });

  it('still writes to the console', () => {
    const buf = new AppLogBuffer();
    buf.warn('visible');
    expect(process.stdout.write).toHaveBeenCalled();
  });
});
