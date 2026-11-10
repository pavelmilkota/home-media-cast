import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Opens the pairing dialog from anywhere. It is app-level state and not a route: a route change
 * would close the player, and pairing from the player must leave the film playing.
 */
export const requestPairing = (): void => set(true);
export const closePairing = (): void => set(false);
export const usePairingOpen = (): boolean => useSyncExternalStore(subscribe, () => open);
