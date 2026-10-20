import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';

export const ACCENTS = ['mint', 'blue', 'green', 'amber', 'rose', 'violet'] as const;
export type Accent = (typeof ACCENTS)[number];

const KEY = 'hmc.theme';
const ACCENT_KEY = 'hmc.accent';
const ORDER: Theme[] = ['system', 'light', 'dark'];
const listeners = new Set<() => void>();

// Storage can throw (private windows, blocked site data). The choice then lives in memory only.
function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return ORDER.find((t) => t === stored) ?? 'system';
  } catch {
    return 'system';
  }
}

function readAccent(): Accent {
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.find((a) => a === stored) ?? 'mint';
  } catch {
    return 'mint';
  }
}

let current: Theme = read();
let accent: Accent = readAccent();

/** Mint is the stylesheet default, so it needs no attribute. */
function applyAccent(next: Accent): void {
  const root = document.documentElement;
  if (next === 'mint') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', next);
}

/** HeroUI reads `.dark` / `data-theme`; "system" leaves both off so prefers-color-scheme decides. */
function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    root.classList.remove('light', 'dark');
  } else {
    root.setAttribute('data-theme', theme);
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
  }
}

export const theme = {
  get: (): Theme => current,
  /** Call once before the first render so the page does not flash the wrong theme. */
  init: (): void => {
    apply(current);
    applyAccent(accent);
  },
  getAccent: (): Accent => accent,
  setAccent(next: Accent): void {
    accent = next;
    applyAccent(next);
    try {
      localStorage.setItem(ACCENT_KEY, next);
    } catch {
      /* in-memory only */
    }
    for (const listener of listeners) listener();
  },
  cycle(): void {
    current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system';
    apply(current);
    try {
      localStorage.setItem(KEY, current);
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

export function useTheme(): Theme {
  return useSyncExternalStore(theme.subscribe, theme.get);
}

export function useAccent(): Accent {
  return useSyncExternalStore(theme.subscribe, theme.getAccent);
}
