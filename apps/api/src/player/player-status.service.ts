import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PlayerEvent, PlayerMedia, PlayerStatus } from '@home-media-cast/shared';
import { Observable, Subject } from 'rxjs';
import { KodiService } from '../kodi/kodi.service.js';

/** Kodi notifications after which the player status has changed. */
const REFRESH_ON = new Set([
  'Player.OnPlay',
  'Player.OnPause',
  'Player.OnResume',
  'Player.OnStop',
  'Player.OnAVStart',
  'Player.OnAVChange',
  'Player.OnSeek',
  'Player.OnSpeedChanged',
  'Player.OnPropertyChanged',
  'Application.OnVolumeChanged',
]);

export interface PlayerStatusOptions {
  /** How often the position is re-read while something is playing. */
  pollIntervalMs?: number;
  /** Notifications arrive in bursts (OnPlay, OnAVStart, ...); read the status once per burst. */
  debounceMs?: number;
}

/**
 * Keeps the latest player status and fans it out to SSE clients. State comes from Kodi's
 * notifications; the position is polled once per second, only while playing and only while
 * somebody is listening.
 */
@Injectable()
export class PlayerStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlayerStatusService.name);
  private readonly subject = new Subject<PlayerEvent>();
  private readonly pollIntervalMs: number;
  private readonly debounceMs: number;
  private last: PlayerStatus | undefined;
  /** The status as Kodi reported it, without `media`. */
  private raw: PlayerStatus | undefined;
  /** Applies to the video whose Kodi title is `title`, until something else plays. */
  private annotation: { media: PlayerMedia; title: string } | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private refreshAgain = false;
  private readonly onNotification = ({ method }: { method: string }) => {
    if (this.subject.observed && REFRESH_ON.has(method)) this.scheduleRefresh();
  };
  private readonly onState = () => {
    this.subject.next({ type: 'kodi', data: this.kodi.health() });
    if (this.subject.observed && this.kodi.health().state === 'connected') this.scheduleRefresh();
  };

  constructor(
    private readonly kodi: KodiService,
    { pollIntervalMs = 1000, debounceMs = 100 }: PlayerStatusOptions = {},
  ) {
    this.pollIntervalMs = pollIntervalMs;
    this.debounceMs = debounceMs;
  }

  onModuleInit(): void {
    this.kodi.events.on('notification', this.onNotification);
    this.kodi.events.on('state', this.onState);
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  onModuleDestroy(): void {
    this.kodi.events.off('notification', this.onNotification);
    this.kodi.events.off('state', this.onState);
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
    this.subject.complete();
  }

  /** The current status, read from Kodi. Throws the Kodi errors the filter maps to HTTP. */
  async current(): Promise<PlayerStatus> {
    const status = await this.kodi.commands.getStatus();
    // Publish, don't just remember: if this read lands between a Kodi notification and the
    // debounced refresh, the refresh would see "no change" and SSE clients would never hear it.
    this.publish(status);
    return this.last ?? status;
  }

  /** Emits the current state first, then every change. Unsubscribing stops the polling. */
  stream(): Observable<PlayerEvent> {
    return new Observable<PlayerEvent>((subscriber) => {
      subscriber.next({ type: 'kodi', data: this.kodi.health() });
      if (this.last) subscriber.next({ type: 'status', data: this.last });
      this.scheduleRefresh();
      return this.subject.subscribe(subscriber);
    });
  }

  /** Names the video now on screen (its Kodi title is `title`); shown as `status.media`. */
  annotate(media: PlayerMedia, title: string): void {
    this.annotation = { media, title };
    if (this.raw) this.publish(this.raw);
  }

  private withMedia(status: PlayerStatus): PlayerStatus {
    if (!status.active) {
      this.annotation = undefined;
      return status;
    }
    return this.annotation?.title === status.title
      ? { ...status, media: this.annotation.media }
      : status;
  }

  private publish(status: PlayerStatus): void {
    this.raw = status;
    const next = this.withMedia(status);
    if (JSON.stringify(next) === JSON.stringify(this.last)) return;
    this.last = next;
    this.subject.next({ type: 'status', data: next });
  }

  private poll(): void {
    if (!this.subject.observed) return;
    if (this.last?.active && this.last.speed !== 0) this.scheduleRefresh(0);
  }

  private scheduleRefresh(delay = this.debounceMs): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), delay);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      this.publish(await this.kodi.commands.getStatus());
    } catch (e) {
      this.logger.debug(`Status refresh failed: ${(e as Error).message}`);
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.scheduleRefresh(0);
      }
    }
  }
}
