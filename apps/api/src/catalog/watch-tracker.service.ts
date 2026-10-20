import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { WATCHED_AT } from './library.service.js';
import type { PlayerStatus } from '@home-media-cast/shared';
import type { Subscription } from 'rxjs';
import type { PlayerStatusService } from '../player/player-status.service.js';
import type { TrackPreferences } from '../player/track-preferences.service.js';
import type { LibraryService, ProgressInput } from './library.service.js';

export type TrackedItem = Omit<ProgressInput, 'positionMs' | 'durationMs'>;

export interface WatchTrackerOptions {
  /** How often the position of a running playback is written. */
  saveEveryMs?: number;
  /** Give up when the TV never starts the video. */
  startTimeoutMs?: number;
  /** Delay before the one retry of the resume seek (Kodi may not accept it right at the start). */
  seekRetryMs?: number;
}

type Active = Extract<PlayerStatus, { active: true }>;

/**
 * Records what is watched from the player status. It follows one playback at a time: the one
 * started by the catalog (`begin`), from the moment the TV shows a new video until it stops.
 * Without this the phone would have to stay open for progress to be saved.
 */
@Injectable()
export class WatchTracker implements OnModuleDestroy {
  private readonly logger = new Logger(WatchTracker.name);
  private readonly saveEveryMs: number;
  private readonly startTimeoutMs: number;
  private readonly seekRetryMs: number;
  private session: { stop: () => void } | undefined;
  private last: { item: TrackedItem; bingeGroup?: string } | undefined;
  /** Called when a tracked playback ended past the "watched" mark and nothing replaced it. */
  onFinished: ((item: TrackedItem, bingeGroup?: string) => void) | undefined;

  constructor(
    private readonly player: PlayerStatusService,
    private readonly library: LibraryService,
    private readonly seek: (positionMs: number) => Promise<void> = async () => undefined,
    { saveEveryMs = 5000, startTimeoutMs = 90_000, seekRetryMs = 1500 }: WatchTrackerOptions = {},
    private readonly tracks?: TrackPreferences,
  ) {
    this.seekRetryMs = seekRetryMs;
    this.saveEveryMs = saveEveryMs;
    this.startTimeoutMs = startTimeoutMs;
  }

  onModuleDestroy(): void {
    this.end();
  }

  /** What is on screen now, to tell the new playback from it. Never throws. */
  async baseline(): Promise<PlayerStatus | undefined> {
    try {
      return await this.player.current();
    } catch {
      return undefined;
    }
  }

  /**
   * Call right before telling Kodi to open `item`; `before` comes from `baseline()`. With
   * `resumeMs` the playback is moved there once the TV shows it.
   */
  begin(
    item: TrackedItem,
    before: PlayerStatus | undefined,
    resumeMs?: number,
    bingeGroup?: string,
  ): void {
    this.end();
    this.last = { item, ...(bingeGroup ? { bingeGroup } : {}) };
    // Remembered at once: a play stopped within seconds still counts as the last selected source.
    if (bingeGroup) this.library.rememberRelease(item.videoId, bingeGroup);
    let tracking: Active | undefined;
    let lastSaved = 0;
    let applyTracks: ((s: Active) => void) | undefined;
    let sawOther = !before?.active;
    const save = (s: Active) =>
      this.library.record({ ...item, positionMs: s.positionMs, durationMs: s.durationMs });
    const sub: Subscription = this.player.stream().subscribe({
      next: (event) => {
        if (event.type !== 'status') return;
        const s = event.data;
        try {
          if (!s.active) {
            sawOther = true;
            if (tracking) {
              const done =
                tracking.durationMs > 0 && tracking.positionMs / tracking.durationMs >= WATCHED_AT;
              this.end(); // saves the last position
              if (done) this.finished(item, bingeGroup);
            }
            return;
          }
          if (!tracking) {
            const isNew =
              sawOther ||
              s.title !== (before as Active).title ||
              s.positionMs < (before as Active).positionMs - 2000;
            if (!isNew) return;
            if (resumeMs) this.resume(resumeMs);
            applyTracks = this.tracks?.forPlayback();
          }
          tracking = s;
          applyTracks?.(s);
          if (Date.now() - lastSaved >= this.saveEveryMs || s.speed === 0) {
            lastSaved = Date.now();
            save(s);
          }
        } catch (e) {
          this.logger.warn(`Could not save progress: ${(e as Error).message}`);
        }
      },
    });
    const timer = setTimeout(() => {
      if (!tracking) this.end();
    }, this.startTimeoutMs);
    this.session = {
      stop: () => {
        clearTimeout(timer);
        sub.unsubscribe();
        if (tracking) {
          try {
            save(tracking);
          } catch {
            // the database is closing
          }
        }
      },
    };
  }

  /** The last playback started from the catalog, even after it ended. */
  lastPlay(): { item: TrackedItem; bingeGroup?: string } | undefined {
    return this.last;
  }

  private finished(item: TrackedItem, bingeGroup?: string): void {
    try {
      this.onFinished?.(item, bingeGroup);
    } catch (e) {
      this.logger.warn(`After-playback hook failed: ${(e as Error).message}`);
    }
  }

  private resume(positionMs: number): void {
    // Never let a failed seek reach the caller: the video plays from the start instead.
    const attempt = (retry: boolean) =>
      this.seek(positionMs).catch((e: Error) => {
        if (retry) setTimeout(() => attempt(false), this.seekRetryMs).unref();
        else this.logger.warn(`Could not resume: ${e.message}`);
      });
    void attempt(true);
  }

  end(): void {
    const s = this.session;
    this.session = undefined;
    s?.stop();
  }
}
