/**
 * `ffmpeg` copying video runs far faster than real time. Left alone it would fill the tmpfs (RAM)
 * and pull the whole file from the debrid account in minutes. So it is paused (`SIGSTOP`) when it
 * is more than `ahead` segments in front of the player, resumed (`SIGCONT`) when the player has
 * caught up half way, and the segments the player is past are deleted.
 */
export interface BackpressureState {
  /** How many segments are complete (the highest finished segment is `written - 1`). */
  written: number;
  /** The highest segment number the player has fetched; -1 before the first. */
  fetched: number;
  /** `ffmpeg` is currently stopped. */
  stopped: boolean;
  /** Segments allowed in front of the player. */
  ahead: number;
  /** Segments kept behind the player. */
  behind: number;
}

export interface BackpressureAction {
  signal?: 'SIGSTOP' | 'SIGCONT';
  /** Delete segments numbered below this. */
  deleteBelow: number;
}

export function decideBackpressure(s: BackpressureState): BackpressureAction {
  const lead = s.written - 1 - s.fetched;
  const deleteBelow = Math.max(0, s.fetched - s.behind);
  if (!s.stopped && lead > s.ahead) return { signal: 'SIGSTOP', deleteBelow };
  if (s.stopped && lead <= Math.floor(s.ahead / 2)) return { signal: 'SIGCONT', deleteBelow };
  return { deleteBelow };
}
