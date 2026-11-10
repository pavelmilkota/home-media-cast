import { useCallback } from 'react';
import { useDeviceKind } from '../api/auth.js';
import { useLive } from './live.js';
import { requestPairing } from './pairing-dialog.js';

/** Kodi is known not to be connected. Unknown (no event yet) is not "down". */
export function useKodiDown(): boolean {
  const { kodi } = useLive();
  return kodi !== undefined && kodi.state !== 'connected';
}

export type TvAccessState = 'allowed' | 'pair' | 'unavailable';

/**
 * One rule for everything only a paired device may do: TV control and writing to the library.
 * A guest with Kodi connected is sent to pairing; with Kodi down pairing is impossible (it needs
 * the code on the projector), so the control is disabled instead.
 */
export function useTvAccess(): {
  state: TvAccessState;
  /** Wraps an action: runs it when allowed, opens pairing for a guest, does nothing when unavailable. */
  guard: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
} {
  const kind = useDeviceKind();
  const kodiDown = useKodiDown();
  const state: TvAccessState = kind === 'paired' ? 'allowed' : kodiDown ? 'unavailable' : 'pair';
  const guard = useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): void => {
        if (state === 'allowed') fn(...args);
        else if (state === 'pair') requestPairing();
      },
    [state],
  );
  return { state, guard };
}
