import type { PlayerStatus } from '@home-media-cast/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

export type StartPhase = 'idle' | 'starting' | 'failed';

/** True when `now` is a different playback from `before` (new title, or the position jumped back). */
function isNewPlayback(before: PlayerStatus | undefined, now: PlayerStatus | undefined): boolean {
  if (!now?.active) return false;
  if (!before?.active) return true;
  return now.title !== before.title || now.positionMs < before.positionMs - 2000;
}

/**
 * The API answers 202 as soon as Kodi accepts a request, even if it cannot play it. Only an
 * active player counts as success; if none shows up in time the phase turns `failed`.
 * Call `begin()` before sending the request and `arm()` once it is accepted.
 */
export function useStartWatch(
  status: PlayerStatus | undefined,
  onStarted: () => void,
  timeoutMs: number,
) {
  const [phase, setPhase] = useState<StartPhase>('idle');
  const before = useRef<PlayerStatus | undefined>(undefined);
  const started = useRef(onStarted);
  started.current = onStarted;

  const begin = useCallback(() => {
    before.current = status;
    setPhase('idle');
  }, [status]);
  const arm = useCallback(() => setPhase('starting'), []);

  useEffect(() => {
    if (phase !== 'starting') return;
    if (isNewPlayback(before.current, status)) {
      setPhase('idle');
      started.current();
      return;
    }
    const timer = setTimeout(() => setPhase('failed'), timeoutMs);
    return () => clearTimeout(timer);
  }, [phase, status, timeoutMs]);

  return { phase, begin, arm };
}
