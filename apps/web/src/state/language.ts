import { useSyncExternalStore } from 'react';
import { i18n } from '../i18n/index.js';

export const LOCALES = ['en', 'pl', 'uk', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export type Language = 'auto' | Locale;

/** Native names; never translated, so a lost user can always find their language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  pl: 'Polski',
  uk: 'Українська',
  ru: 'Русский',
};

const KEY = 'hmc.lang';
const listeners = new Set<() => void>();

/** First supported device language wins (`pl-PL` -> `pl`); anything else is English. */
export function resolveDeviceLocale(
  languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): Locale {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0];
    const hit = LOCALES.find((l) => l === primary);
    if (hit) return hit;
  }
  return 'en';
}

// Storage can throw (private windows, blocked site data). The choice then lives in memory only.
function read(): Language {
  try {
    const stored = localStorage.getItem(KEY);
    return LOCALES.find((l) => l === stored) ?? 'auto';
  } catch {
    return 'auto';
  }
}

let current: Language = read();

function resolved(): Locale {
  return current === 'auto' ? resolveDeviceLocale() : current;
}

function apply(): void {
  void i18n.changeLanguage(resolved());
  document.documentElement.lang = resolved();
}

export const language = {
  get: (): Language => current,
  getLocale: (): Locale => resolved(),
  /** Call once before the first render so the page does not flash the wrong language. */
  init: (): void => apply(),
  set(next: Language): void {
    current = next;
    apply();
    try {
      if (next === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* in-memory only */
    }
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The stored preference, including "auto". */
export function useLanguage(): Language {
  return useSyncExternalStore(language.subscribe, language.get);
}

/** The locale actually in use. */
export function useLocale(): Locale {
  return useSyncExternalStore(language.subscribe, language.getLocale);
}
