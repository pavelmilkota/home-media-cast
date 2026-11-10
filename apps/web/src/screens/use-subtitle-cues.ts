import { useEffect, useState } from 'react';
import { parseVtt, type Cue } from '../state/webvtt.js';

/** The file grows as `ffmpeg` reads on; ask again this often. */
const REFRESH_MS = 4000;
/**
 * ...and at most this seldom while the file is missing. A run's file appears a moment after the
 * run starts, so a long wait here only leaves the subtitles off for no reason.
 */
const MAX_REFRESH_MS = 8000;

/**
 * The cues of one subtitle file of the current run, refreshed while it grows. `url` is undefined
 * for "off". The media route is public (the session id in the path is the capability), so a plain
 * `fetch` does. Cues are on the run's clock, which is what `video.currentTime` shows.
 */
export function useSubtitleCues(url: string | undefined): Cue[] {
  const [cues, setCues] = useState<Cue[]>([]);
  useEffect(() => {
    setCues([]);
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const load = async () => {
      clearTimeout(timer);
      let ok = false;
      try {
        const res = await fetch(url, { cache: 'no-store' });
        ok = res.ok;
        if (ok && !cancelled) {
          const parsed = parseVtt(await res.text());
          if (!cancelled) setCues((old) => (old.length === parsed.length ? old : parsed));
        }
      } catch {
        /* the next refresh tries again */
      }
      if (cancelled) return;
      // A file that is not there (yet) is asked for less and less often, not every few seconds.
      misses = ok ? 0 : misses + 1;
      clearTimeout(timer); // a load started by the tab coming back may overlap this one
      timer = setTimeout(
        () => void load(),
        misses === 0 ? REFRESH_MS : Math.min(MAX_REFRESH_MS, REFRESH_MS * 2 ** (misses - 1)),
      );
    };
    // A file that was not there yet, or a request that failed while the tab was in the background,
    // is asked for again as soon as the tab is back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [url]);
  return cues;
}
