/**
 * A guest's resume positions live in its own browser: the server keeps nothing of a guest's play.
 * `{ [videoId]: { positionMs, durationMs, at } }`, the newest 50, dropped once past the watched mark.
 */
export interface GuestProgress {
  positionMs: number;
  durationMs: number;
  at: number;
}

const KEY = 'hmc.guestProgress';
export const MAX_ENTRIES = 50;
/** The server's "watched" mark: a finished film is not offered for resume. */
export const WATCHED_FRACTION = 0.9;

function readAll(): Record<string, GuestProgress> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, GuestProgress>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, GuestProgress>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* nothing can be kept */
  }
}

export const guestProgress = {
  get(videoId: string): GuestProgress | undefined {
    return readAll()[videoId];
  },
  /** The fraction (0..1) watched, for the picker's resume line. */
  fraction(videoId: string): number | undefined {
    const p = readAll()[videoId];
    return p && p.durationMs > 0 ? p.positionMs / p.durationMs : undefined;
  },
  save(videoId: string, positionMs: number, durationMs: number, now = Date.now()): void {
    const all = readAll();
    if (durationMs > 0 && positionMs / durationMs >= WATCHED_FRACTION) {
      delete all[videoId];
    } else {
      all[videoId] = {
        positionMs: Math.round(positionMs),
        durationMs: Math.round(durationMs),
        at: now,
      };
    }
    const newest = Object.entries(all)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_ENTRIES);
    writeAll(Object.fromEntries(newest));
  },
};
