import { useSyncExternalStore } from 'react';
import { useDeviceKind } from '../api/auth.js';
import { useKodiDown } from './use-tv-access.js';

/** Where a tapped source plays: the TV (Kodi) or this device's own screen. */
export type PlayTarget = 'tv' | 'browser';

const KEY = 'hmc.playTarget';
const listeners = new Set<() => void>();

// Storage can throw (private windows, blocked site data). The choice then lives in memory only.
// An absent key means "not chosen yet", which `useEffectiveTarget` resolves.
function read(): PlayTarget | undefined {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'browser' || stored === 'tv' ? stored : undefined;
  } catch {
    return undefined;
  }
}

let current: PlayTarget | undefined = read();

export const playTarget = {
  get: (): PlayTarget | undefined => current,
  set(next: PlayTarget): void {
    if (next === current) return;
    current = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* in-memory only */
    }
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Re-reads storage; for tests that change it behind the module's back. */
  reload(): void {
    current = read();
    for (const listener of listeners) listener();
  },
};

/** The stored choice, if there is one. */
export function usePlayTarget(): [PlayTarget | undefined, (next: PlayTarget) => void] {
  const target = useSyncExternalStore(playTarget.subscribe, playTarget.get);
  return [target, playTarget.set];
}

/**
 * Where a play goes now. A guest always plays here. Otherwise the stored choice wins, even `tv`
 * while Kodi is down (the TV segment is then disabled, and one tap on "This device" moves off it).
 * With no choice yet it is this device when Kodi is known to be down, else the TV.
 */
export function useEffectiveTarget(): PlayTarget {
  const kind = useDeviceKind();
  const [stored] = usePlayTarget();
  const kodiDown = useKodiDown();
  if (kind === 'guest') return 'browser';
  return stored ?? (kodiDown ? 'browser' : 'tv');
}
