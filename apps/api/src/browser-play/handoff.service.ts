import { NotFoundException } from '@nestjs/common';
import type {
  BrowserSession,
  DeviceCaps,
  HandoffPickSource,
  PlayerStatus,
} from '@home-media-cast/shared';
import type { ActivePlay } from '../catalog/watch-tracker.service.js';
import { OptionExpiredError, type StreamsService } from '../sources/streams.service.js';
import { releaseKey, type ClassifiedResult } from '../sources/stream-source.js';
import { NoMatchingSourceError, type WatchPlayService } from '../sources/watch-play.service.js';
import {
  BrowserUnsupportedError,
  type ActiveBrowserSession,
  type BrowserSessionService,
} from './browser-session.service.js';
import type { SessionHub } from './session-hub.js';

/**
 * The session cannot continue on its own: its release cannot be told, or this device cannot play
 * it. The old session keeps playing, and the client opens the picker for the title (409).
 */
export class HandoffPickSourceError extends Error {
  override readonly name = 'HandoffPickSourceError';
  constructor(
    readonly pick: HandoffPickSource,
    message = 'Pick a source for this title to continue',
  ) {
    super(message);
  }
}

interface Origin {
  title: { type: 'movie' | 'series'; id: string };
  /** Absent to start where the library says. */
  positionMs: number | undefined;
  key: string | undefined;
}

type Active = Extract<PlayerStatus, { active: true }>;

/** "Continue here" and "Send to TV": move the one active session to another device. */
export class HandoffService {
  constructor(
    private readonly sessions: BrowserSessionService,
    private readonly hub: SessionHub,
    private readonly streams: StreamsService,
    private readonly watch: WatchPlayService,
    private readonly tv: {
      activePlay(): ActivePlay | undefined;
      status(): Promise<PlayerStatus>;
    },
  ) {}

  /** Takes the active session (the TV's or another device's) to `deviceId`. */
  async here(deviceId: string, caps: DeviceCaps): Promise<BrowserSession> {
    const shown = this.tv.activePlay();
    const status = shown ? await this.tv.status() : undefined;
    if (shown && status?.active) return this.fromTv(deviceId, caps, shown, status);

    // Another device's play; failing that, this device's own external player can be brought in.
    const other = this.hub.activeElsewhere(deviceId) ?? this.hub.activeExternalOf(deviceId);
    if (!other) throw new NotFoundException('Nothing is playing');
    return this.fromBrowser(deviceId, caps, other);
  }

  /**
   * Starts a play from the history in this browser: the same release, found anew. Without a release
   * key there is nothing to tell the dub by, and "any release" is the TV's habit alone, so the
   * client is asked to pick. The TV replay is `WatchPlayService.replay` and is not changed.
   */
  async replayHere(
    deviceId: string,
    historyId: string,
    caps: DeviceCaps,
    guest = false,
  ): Promise<BrowserSession> {
    const entry = this.watch.historyEntry(historyId);
    const origin: Origin = {
      title: { type: entry.type, id: entry.id },
      positionMs: undefined,
      key: entry.releaseKey || undefined,
    };
    if (!origin.key) throw new HandoffPickSourceError(this.pick(origin));
    const optionId = await this.streams.findMatching(entry.type, entry.id, origin.key);
    if (!optionId) throw new NoMatchingSourceError('No playable source from the same release');
    return this.startHere(deviceId, caps, origin, this.streams.resolveOption(optionId), optionId, {
      guest,
    });
  }

  /**
   * Plays a browser session on the TV, from the position it reached: `deviceId`'s own when it has
   * one (several can play at once), else the one playing.
   */
  async toTv(deviceId: string, positionMs?: number): Promise<void> {
    const active = this.hub.active(deviceId);
    if (!active) throw new NotFoundException('Nothing is playing in a browser');
    const item = active.tracked;
    if (!item) throw new NotFoundException('This play has no title to continue on the TV');
    const at = positionMs ?? active.positionMs;
    const origin: Origin = {
      title: { type: item.title.type, id: item.videoId },
      positionMs: at,
      key: releaseKey(active.classified),
    };
    // The TV resumes from the library, so the position goes there first. A paired device acted on
    // a guest's play here, so it is the household's now.
    this.watch.saveBrowserProgress(item, at, active.durationMs);
    // Marked before the TV starts, so a guest's session ends when the TV is seen to start.
    const unmark = this.hub.handOver(active.id);
    try {
      const optionId = await this.optionFor(active.optionId, origin);
      if (!optionId) throw new HandoffPickSourceError(this.pick(origin));
      await this.watch.play({ optionId, title: origin.title });
    } catch (e) {
      unmark?.();
      throw e;
    }
    // The browser session ends when the TV is seen to start (see `SessionCoordinator`).
  }

  private async fromTv(
    deviceId: string,
    caps: DeviceCaps,
    shown: ActivePlay,
    status: Active,
  ): Promise<BrowserSession> {
    const origin: Origin = {
      title: { type: shown.item.title.type, id: shown.item.videoId },
      positionMs: status.positionMs,
      key: shown.bingeGroup,
    };
    const optionId = await this.optionFor(shown.optionId, origin);
    if (!optionId) throw new HandoffPickSourceError(this.pick(origin));
    return this.startHere(deviceId, caps, origin, this.streams.resolveOption(optionId), optionId, {
      takeover: true,
    });
  }

  private fromBrowser(
    deviceId: string,
    caps: DeviceCaps,
    other: ActiveBrowserSession,
  ): Promise<BrowserSession> {
    const item = other.tracked;
    if (!item) throw new NotFoundException('This play has no title to continue');
    const origin: Origin = {
      title: { type: item.title.type, id: item.videoId },
      positionMs: other.positionMs,
      key: releaseKey(other.classified),
    };
    // The session still holds its source, which is better than any option id.
    return this.startHere(deviceId, caps, origin, other.classified, undefined, { takeover: true });
  }

  private async startHere(
    deviceId: string,
    caps: DeviceCaps,
    origin: Origin,
    classified: ClassifiedResult,
    optionId: string | undefined,
    { guest = false, takeover = false }: { guest?: boolean; takeover?: boolean } = {},
  ): Promise<BrowserSession> {
    try {
      return await this.sessions.startSource(deviceId, {
        classified,
        ...(guest ? { guest } : {}),
        ...(takeover ? { takeover } : {}),
        ...(optionId ? { optionId } : {}),
        title: origin.title,
        caps,
        ...(origin.positionMs !== undefined ? { startMs: origin.positionMs } : {}),
      });
    } catch (e) {
      // This device cannot play it: the old session keeps going and the picker explains.
      if (e instanceof BrowserUnsupportedError) {
        throw new HandoffPickSourceError(this.pick(origin), e.message);
      }
      throw e;
    }
  }

  /**
   * The playing option while it is still listed, else a match of the same release; never a match of
   * "any release", which could silently change the dub.
   */
  private async optionFor(
    optionId: string | undefined,
    origin: Origin,
  ): Promise<string | undefined> {
    if (optionId) {
      try {
        this.streams.resolveOption(optionId);
        return optionId;
      } catch (e) {
        if (!(e instanceof OptionExpiredError)) throw e;
      }
    }
    if (!origin.key) return undefined;
    return this.streams.findMatching(origin.title.type, origin.title.id, origin.key);
  }

  private pick(origin: Origin): HandoffPickSource {
    return {
      type: origin.title.type,
      videoId: origin.title.id,
      positionMs: Math.round(origin.positionMs ?? 0),
    };
  }
}
