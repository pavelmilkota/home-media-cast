import { useSyncExternalStore } from 'react';

const KEY = 'hmc.token';
const listeners = new Set<() => void>();

// Storage can throw (private windows, blocked site data). The token then lives in memory only.
function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let token: string | null = read();

function emit(): void {
  for (const listener of listeners) listener();
}

export const auth = {
  get: (): string | null => token,
  set(next: string): void {
    token = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* in-memory only */
    }
    emit();
  },
  clear(): void {
    token = null;
    try {
      localStorage.removeItem(KEY);
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
