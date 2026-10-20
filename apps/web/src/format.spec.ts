import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from './i18n/index.js';
import { ageLabel, formatTime, guessDeviceName, timeAgo } from './format.js';

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [75_000, '1:15'],
    [3_725_000, '1:02:05'],
    [-5, '0:00'],
  ])('%i -> %s', (ms, expected) => expect(formatTime(ms)).toBe(expected));
});

describe('timeAgo', () => {
  const now = 1_000_000_000;
  it.each([
    [null, 'never'],
    [now - 5_000, 'just now'],
    [now - 5 * 60_000, '5 min ago'],
    [now - 3 * 3_600_000, '3 h ago'],
  ])('%s -> %s', (t, expected) => expect(timeAgo(t, now)).toBe(expected));
});

describe('ageLabel', () => {
  const now = 1_000_000_000;
  it.each([
    [now - 30_000, 'just now'],
    [now - 5 * 60_000, '5 min ago'],
    [now - 3 * 3_600_000, '3 h ago'],
    [now - 47 * 3_600_000, '47 h ago'],
    [now - 72 * 3_600_000, '3 d ago'],
    [now + 5_000, 'just now'],
  ])('%s -> %s', (t, expected) => expect(ageLabel(t, now)).toBe(expected));
});

describe('guessDeviceName', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', 'Android phone'],
    ['Mozilla/5.0 (Linux; Android 14; SM-X900) Safari', 'Android tablet'],
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox', 'Linux PC'],
  ])('%s -> %s', (ua, expected) => expect(guessDeviceName(ua)).toBe(expected));
});

describe('translated labels', () => {
  const now = 1_000_000_000;
  afterEach(() => void i18n.changeLanguage('en'));

  it.each([
    ['pl', 'przed chwilą', '5 min temu', '3 godz. temu'],
    ['uk', 'щойно', '5 хв тому', '3 год тому'],
    ['ru', 'только что', '5 мин назад', '3 ч назад'],
  ])('%s', async (lng, justNow, minutes, hours) => {
    await i18n.changeLanguage(lng);
    expect(ageLabel(now - 30_000, now)).toBe(justNow);
    expect(ageLabel(now - 5 * 60_000, now)).toBe(minutes);
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe(hours);
  });

  it('picks the Slavic plural form', async () => {
    await i18n.changeLanguage('pl');
    expect([1, 2, 5, 22].map((count) => i18n.t('cache.lists', { count }))).toEqual([
      '1 lista',
      '2 listy',
      '5 list',
      '22 listy',
    ]);
  });
});
