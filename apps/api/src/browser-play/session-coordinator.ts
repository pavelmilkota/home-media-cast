import { Logger, NotFoundException } from '@nestjs/common';
import type { BrowserStatus, PlayerEvent, PlayerStatus } from '@home-media-cast/shared';
import type { Observable, Subscription } from 'rxjs';
import { mediaOf } from '../catalog/watch-tracker.service.js';
import { handoffIdOf } from './browser-session.service.js';
import type { SessionHub } from './session-hub.js';

/** The part of the player status service the coordinator uses. */
export interface StatusPort {
  stream(): Observable<PlayerEvent>;
  current(): Promise<PlayerStatus>;
  setBrowser(status: BrowserStatus): void;
}

/** What it takes to end the TV's side of a session. */
export interface TvPort {
  /** Stops following the TV's playback (saves its position). Must come before `stop`. */
  endTracking(): void;
  stop(): Promise<void>;
}

/**
 * One active session across the household. A new player takes over only once it has really
 * started, and anything that starts on the TV ends the browser session, however it got there.
 */
export class SessionCoordinator {
  private readonly logger = new Logger(SessionCoordinator.name);
  private watching: Subscription | undefined;
  private lastHandoffId: string | undefined;

  constructor(
    private readonly sessions: SessionHub,
    private readonly tv: TvPort,
    private readonly status: StatusPort,
  ) {
    sessions.onChange(() => this.refresh());
  }

  onModuleDestroy(): void {
    this.watching?.unsubscribe();
    this.watching = undefined;
  }

  /**
   * The player of session `id` fired its first `playing` event. A play alongside (a guest's, or one
   * neither converted nor handed off) takes nothing over. Otherwise the sessions it replaces end, and
   * so does the TV: the tracker first, so that a stop past 90% does not read as "finished" and start
   * the next episode on the TV.
   */
  async confirmStarted(id: string, deviceId: string): Promise<void> {
    if (!this.sessions.confirm(id, deviceId))
      throw new NotFoundException('No such browser session');
    await this.takeOver(id);
  }

  /**
   * An external player made its first sequential read of session `id`: the same rule as
   * `confirmStarted`, started by the player's request instead of a client's report.
   */
  async confirmExternal(id: string): Promise<void> {
    await this.takeOver(id);
  }

  private async takeOver(id: string): Promise<void> {
    const { stopsTv } = await this.sessions.takeOverFor(id);
    if (!stopsTv) return;
    this.tv.endTracking();
    try {
      await this.tv.stop();
    } catch {
      // Kodi is off, or nothing was playing: there is nothing to stop.
    }
  }

  private refresh(): void {
    const active = this.sessions.active();
    if (!active) {
      this.watching?.unsubscribe();
      this.watching = undefined;
      this.lastHandoffId = undefined;
      this.status.setBrowser({ active: false });
      return;
    }
    const handoffId = handoffIdOf(active.id);
    this.status.setBrowser({
      active: true,
      deviceId: active.deviceId,
      deviceName: active.deviceName,
      ...(active.tracked ? { media: mediaOf(active.tracked) } : {}),
      positionMs: active.positionMs,
      durationMs: active.durationMs,
      handoffId,
      ...(active.approximate ? { approximate: true } : {}),
    });
    if (this.lastHandoffId !== handoffId) {
      this.lastHandoffId = handoffId;
      this.watching?.unsubscribe();
      this.watching = undefined;
    }
    if (!this.watching) void this.watchTv();
  }

  /** Ends the browser session when the TV starts a new playback. */
  private async watchTv(): Promise<void> {
    // Read once first, so the status the stream replays is the baseline and not a "new" playback.
    await this.status.current().catch(() => undefined);
    if (this.watching || !this.sessions.active()) return;
    let prev: PlayerStatus | undefined;
    let seen = false;
    this.watching = this.status.stream().subscribe((event) => {
      if (event.type !== 'status') return;
      const next = event.data;
      if (!seen) {
        seen = true;
        prev = next;
        return;
      }
      const isNew = next.active && (!prev?.active || prev.title !== next.title);
      prev = next;
      if (isNew) {
        this.logger.log('The TV started something: the paired sessions end');
        void this.sessions.endForTv();
      }
    });
  }
}
