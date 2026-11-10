import { useSyncExternalStore } from 'react';

const KEY = 'hmc.token';
const KIND_KEY = 'hmc.tokenKind';
const listeners = new Set<() => void>();

/** A guest browses and plays; a paired device also controls the TV and writes to the library. */
export type DeviceKind = 'paired' | 'guest';

// Storage can throw (private windows, blocked site data). The token then lives in memory only.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let token: string | null = read(KEY);
// A token stored before guests existed has no kind, and is a paired one.
let kind: DeviceKind = read(KIND_KEY) === 'guest' ? 'guest' : 'paired';

function emit(): void {
  for (const listener of listeners) listener();
}

export const auth = {
  get: (): string | null => token,
  kind: (): DeviceKind => kind,
  set(next: string, nextKind: DeviceKind = 'paired'): void {
    token = next;
    kind = nextKind;
    try {
      localStorage.setItem(KEY, next);
      localStorage.setItem(KIND_KEY, nextKind);
    } catch {
      /* in-memory only */
    }
    emit();
  },
  clear(): void {
    token = null;
    kind = 'paired';
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(KIND_KEY);
    } catch {
      /* nothing stored */
    }
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const useToken = (): string | null => useSyncExternalStore(auth.subscribe, auth.get);
export const useDeviceKind = (): DeviceKind => useSyncExternalStore(auth.subscribe, auth.kind);
