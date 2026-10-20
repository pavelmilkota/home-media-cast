import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n/index.js';
import { language, resolveDeviceLocale } from './language.js';

describe('resolveDeviceLocale', () => {
  it.each([
    [['pl-PL'], 'pl'],
    [['uk'], 'uk'],
    [['ru-RU', 'en-US'], 'ru'],
    [['de-DE', 'pl'], 'pl'],
    [['de-DE', 'fr'], 'en'],
    [['PL'], 'pl'],
    [[], 'en'],
  ])('%j -> %s', (languages, expected) => expect(resolveDeviceLocale(languages)).toBe(expected));
});

describe('language', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    language.set('auto');
    vi.restoreAllMocks();
  });

  it('a chosen language switches the UI, <html lang> and storage', () => {
    language.set('pl');
    expect(i18n.t('tabs.search')).toBe('Szukaj');
    expect(document.documentElement.lang).toBe('pl');
    expect(localStorage.getItem('hmc.lang')).toBe('pl');
  });

  it('auto follows the device and clears the stored choice', () => {
    language.set('ru');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['uk-UA']);
    language.set('auto');
    expect(language.get()).toBe('auto');
    expect(language.getLocale()).toBe('uk');
    expect(document.documentElement.lang).toBe('uk');
    expect(localStorage.getItem('hmc.lang')).toBeNull();
  });

  it('keeps working in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    language.set('uk');
    expect(language.get()).toBe('uk');
    expect(i18n.t('tabs.home')).toBe('Головна');
  });
});
