import { useCallback, useEffect, useRef, useState } from 'react';

/** Taps within this long of each other make one seek. */
export const COLLECT_MS = 600;
/** While a seek runs, a collected one waits for it, checking this often. */
const WAIT_MS = 50;

/**
 * Turns quick "±10 s" taps into one seek, since a seek outside the current run restarts `ffmpeg`.
 * A tap that lands inside the run (`instant`) seeks at once instead: it costs nothing. Each tap moves a
 * target that starts from the pending position (the last tap's, or the running seek's, or the
 * player's), the screen follows it at once, and one `goTo` fires `COLLECT_MS` after the last tap.
 * A slider commit cancels the taps and seeks at once. Taps during a running seek collect for the
 * next one. Unmounting cancels.
 */
export function useSeekCollector({
  current,
  clamp,
  goTo,
  instant = () => false,
  delayMs = COLLECT_MS,
}: {
  /** Where a new tap measures from when nothing is collected: a running seek's target, else the player. */
  current: () => number;
  clamp: (ms: number) => number;
  goTo: (ms: number) => Promise<void>;
  /** Whether a seek to `ms` needs no new run, so it need not wait for more taps. */
  instant?: (ms: number) => boolean;
  delayMs?: number;
}) {
  const [target, setTarget] = useState<number | undefined>();
  const targetRef = useRef<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef<Promise<void> | undefined>(undefined);
  const latest = useRef({ current, clamp, goTo, instant });
  latest.current = { current, clamp, goTo, instant };

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    targetRef.current = undefined;
    setTarget(undefined);
  }, []);

  const fire = useCallback(() => {
    timer.current = undefined;
    const to = targetRef.current;
    if (to === undefined) return;
    if (running.current) {
      // A seek is still running: this one goes after it.
      timer.current = setTimeout(fire, WAIT_MS);
      return;
    }
    targetRef.current = undefined;
    setTarget(undefined);
    running.current = latest.current.goTo(to).finally(() => {
      running.current = undefined;
    });
  }, []);

  /** A tap of `deltaMs` (negative to go back). */
  const tap = useCallback(
    (deltaMs: number) => {
      const from = targetRef.current ?? latest.current.current();
      const next = latest.current.clamp(from + deltaMs);
      targetRef.current = next;
      setTarget(next);
      clearTimeout(timer.current);
      if (!running.current && latest.current.instant(next)) fire();
      else timer.current = setTimeout(fire, delayMs);
    },
    [delayMs, fire],
  );

  /** The slider was released: any collected taps are dropped and this seeks at once. */
  const commit = useCallback(
    (ms: number) => {
      cancel();
      const seeking = latest.current.goTo(ms).finally(() => {
        if (running.current === seeking) running.current = undefined;
      });
      running.current = seeking;
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  return { target, tap, commit, cancel };
}
