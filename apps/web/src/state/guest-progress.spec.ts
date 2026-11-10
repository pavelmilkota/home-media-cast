import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ENTRIES, guestProgress } from './guest-progress.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('guest progress', () => {
  it('writes a position and reads it back, with its fraction', () => {
    guestProgress.save('tt1', 30_000, 120_000, 5);
    expect(guestProgress.get('tt1')).toEqual({ positionMs: 30_000, durationMs: 120_000, at: 5 });
    expect(guestProgress.fraction('tt1')).toBe(0.25);
    expect(guestProgress.fraction('nope')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('hmc.guestProgress')!)).toHaveProperty('tt1');
  });

  it('keeps only the newest 50', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) guestProgress.save(`tt${i}`, 1000, 10_000, i);
    const all = JSON.parse(localStorage.getItem('hmc.guestProgress')!) as Record<string, unknown>;
    expect(Object.keys(all)).toHaveLength(MAX_ENTRIES);
    expect(guestProgress.get('tt0')).toBeUndefined();
    expect(guestProgress.get(`tt${MAX_ENTRIES + 4}`)).toBeDefined();
  });

  it('drops an item once it is past the watched mark', () => {
    guestProgress.save('tt1', 30_000, 100_000);
    guestProgress.save('tt1', 95_000, 100_000);
    expect(guestProgress.get('tt1')).toBeUndefined();
  });

  it('survives garbage in storage and a storage that throws', () => {
    localStorage.setItem('hmc.guestProgress', '{not json');
    expect(guestProgress.get('tt1')).toBeUndefined();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => guestProgress.save('tt1', 1, 10)).not.toThrow();
  });
});
