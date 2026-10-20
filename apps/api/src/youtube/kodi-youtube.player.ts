import { Logger } from '@nestjs/common';
import { Constants, Player, type Video, type Volume } from 'yt-cast-receiver';
import type { PlayerStatus } from '@home-media-cast/shared';
import { YOUTUBE_VIDEO_ID } from '../kodi/kodi.commands.js';
import { KodiNoActivePlayerError } from '../kodi/kodi.errors.js';
import type { KodiService } from '../kodi/kodi.service.js';
import type { KodiNotification } from '../kodi/kodi.types.js';

const { PLAYER_STATUSES } = Constants;

export interface KodiYouTubePlayerOptions {
  /** How long to wait for Kodi to report that the video actually started. */
  startTimeoutMs?: number;
  /** `doGet*` are called together; one Kodi status read serves all of them. */
  statusCacheMs?: number;
}

interface StopData {
  data?: { end?: boolean };
}

/**
 * The cast receiver's player, backed by Kodi (ADR-0003). Every command maps onto the fixed
 * set in `KodiCommands`; the only thing a sender controls is a validated YouTube video id.
 *
 * `Player.Open` answers OK even when nothing plays (the addon's first-run wizard, a dead
 * video), so `doPlay` reports success only once Kodi announces `Player.OnAVStart`.
 */
export class KodiYouTubePlayer extends Player {
  private readonly log = new Logger(KodiYouTubePlayer.name);
  private readonly startTimeoutMs: number;
  private readonly statusCacheMs: number;
  /** True from the moment we ask Kodi to open a video until it starts (or fails). */
  private opening = false;
  private cached: { at: number; status: Promise<PlayerStatus> } | undefined;
  private readonly startWaiters = new Set<(started: boolean) => void>();
  private readonly onNotification = (n: KodiNotification) => void this.handleNotification(n);

  constructor(
    private readonly kodi: KodiService,
    { startTimeoutMs = 20_000, statusCacheMs = 250 }: KodiYouTubePlayerOptions = {},
  ) {
    super();
    this.startTimeoutMs = startTimeoutMs;
    this.statusCacheMs = statusCacheMs;
  }

  /** Starts following Kodi's notifications so changes made on Kodi reach the phone. */
  attach(): void {
    this.kodi.events.on('notification', this.onNotification);
  }

  detach(): void {
    this.kodi.events.off('notification', this.onNotification);
    for (const resolve of [...this.startWaiters]) resolve(false);
  }

  protected async doPlay(video: Video, position: number): Promise<boolean> {
    if (!YOUTUBE_VIDEO_ID.test(video.id)) {
      this.log.warn('Refusing to play a video id of an unexpected shape');
      return false;
    }
    this.opening = true;
    this.invalidate();
    const started = this.waitForStart();
    try {
      await this.kodi.commands.openYouTube(video.id);
      if (!(await started)) {
        this.log.warn(`Kodi did not start ${video.id} within ${this.startTimeoutMs} ms`);
        return false;
      }
      if (position >= 2) await this.kodi.commands.seek({ positionMs: position * 1000 });
      return true;
    } catch (e) {
      this.log.warn(`Could not play ${video.id}: ${(e as Error).message}`);
      return false;
    } finally {
      this.opening = false;
      this.invalidate();
    }
  }

  protected doPause(): Promise<boolean> {
    return this.attempt('pause', () => this.kodi.commands.playPause(false));
  }

  protected doResume(): Promise<boolean> {
    return this.attempt('resume', () => this.kodi.commands.playPause(true));
  }

  protected async doStop(): Promise<boolean> {
    try {
      await this.kodi.commands.stop();
    } catch (e) {
      if (!(e instanceof KodiNoActivePlayerError)) {
        this.log.warn(`Could not stop: ${(e as Error).message}`);
        return false;
      }
    }
    this.invalidate();
    return true;
  }

  protected doSeek(position: number): Promise<boolean> {
    return this.attempt('seek', () =>
      this.kodi.commands.seek({ positionMs: Math.max(0, position) * 1000 }),
    );
  }

  protected doSetVolume(volume: Volume): Promise<boolean> {
    return this.attempt('set volume', async () => {
      await this.kodi.commands.setVolume(Math.min(100, Math.max(0, Math.round(volume.level))));
      await this.kodi.commands.setMuted(volume.muted);
    });
  }

  protected async doGetVolume(): Promise<Volume> {
    const { volume, muted } = await this.readStatus();
    return { level: volume, muted };
  }

  protected async doGetPosition(): Promise<number> {
    const s = await this.readStatus();
    return s.active ? s.positionMs / 1000 : 0;
  }

  protected async doGetDuration(): Promise<number> {
    const s = await this.readStatus();
    return s.active ? s.durationMs / 1000 : 0;
  }

  private async attempt(what: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      this.invalidate();
      return true;
    } catch (e) {
      this.log.warn(`Could not ${what}: ${(e as Error).message}`);
      return false;
    }
  }

  private readStatus(): Promise<PlayerStatus> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > this.statusCacheMs) {
      const status = this.kodi.commands.getStatus();
      this.cached = { at: now, status };
      // A failed read must not stay cached.
      status.catch(() => {
        if (this.cached?.status === status) this.cached = undefined;
      });
    }
    return this.cached.status;
  }

  private invalidate(): void {
    this.cached = undefined;
  }

  private waitForStart(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (started: boolean) => {
        clearTimeout(timer);
        this.startWaiters.delete(done);
        resolve(started);
      };
      const timer = setTimeout(() => done(false), this.startTimeoutMs);
      this.startWaiters.add(done);
    });
  }

  /** Changes made on Kodi itself (remote, keyboard) are reported back to the phone. */
  private async handleNotification({ method, params }: KodiNotification): Promise<void> {
    this.invalidate();
    if (method === 'Player.OnAVStart') {
      for (const resolve of [...this.startWaiters]) resolve(true);
      return;
    }
    // Kodi is still switching items, or we are not casting: the notification is not ours.
    if (this.opening) return;
    if (this.status === PLAYER_STATUSES.IDLE || this.status === PLAYER_STATUSES.STOPPED) return;
    try {
      switch (method) {
        case 'Player.OnPause':
          await this.notifyExternalStateChange(PLAYER_STATUSES.PAUSED);
          break;
        case 'Player.OnResume':
          await this.notifyExternalStateChange(PLAYER_STATUSES.PLAYING);
          break;
        case 'Player.OnSeek':
        case 'Application.OnVolumeChanged':
          await this.notifyExternalStateChange();
          break;
        case 'Player.OnStop':
          if ((params as StopData | undefined)?.data?.end) {
            // Played to the end: let the queue (and autoplay) pick the next video.
            if (!(await this.next())) await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
          } else {
            await this.notifyExternalStateChange(PLAYER_STATUSES.STOPPED);
          }
          break;
      }
    } catch (e) {
      this.log.warn(`Could not pass ${method} on to the sender: ${(e as Error).message}`);
    }
  }
}
