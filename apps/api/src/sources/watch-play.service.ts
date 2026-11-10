import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AdjacentEpisodes,
  QueueAddDto,
  PlaybackHistoryResponse,
  QueueEntry,
  StreamPlayDto,
} from '@home-media-cast/shared';
import type { TrackedItem } from '../catalog/watch-tracker.service.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { WatchTracker } from '../catalog/watch-tracker.service.js';
import { toPlayedItem, type PlaybackHistoryStore } from './playback-history.store.js';
import type { QueueService } from './queue.service.js';
import type { OptionDescription, StreamsService } from './streams.service.js';

const episodeLabel = (season: number | undefined, episode: number | undefined, name: string) =>
  season === undefined ? name : `S${season}E${episode} · ${name}`;

/** The last play was not an episode, or it was the first / final one. */
export class NoAdjacentEpisodeError extends Error {
  override readonly name = 'NoAdjacentEpisodeError';
}

/** No source of the same release group exists for the next episode. */
export class NoMatchingSourceError extends Error {
  override readonly name = 'NoMatchingSourceError';
}

/**
 * Plays a source for a catalog title and keeps the library informed: progress, resume, and
 * the next episode. Playback never depends on the metadata service (see `contextOrUndefined`).
 */
@Injectable()
export class WatchPlayService {
  private readonly logger = new Logger(WatchPlayService.name);

  constructor(
    private readonly streams: StreamsService,
    private readonly catalog: CatalogService,
    private readonly tracker: WatchTracker,
    readonly queue: QueueService,
    private readonly history: PlaybackHistoryStore,
    { autoNext }: { autoNext: boolean },
  ) {
    // The queue is an explicit request, so it goes first and does not depend on `autoNext`.
    tracker.onFinished = (item, group) => {
      if (queue.list().length) void this.advanceQueue();
      else if (autoNext && item.season !== undefined) void this.advance(group);
    };
  }

  /** Puts a title on the queue; the picked source only tells which release to look for. */
  async enqueue(dto: QueueAddDto): Promise<QueueEntry> {
    const item = await this.catalog.context(dto.title.type, dto.title.id);
    if (!item) throw new RangeError('Not a valid title id');
    return this.queue.add(
      {
        type: dto.title.type,
        videoId: item.videoId,
        name: item.title.name,
        ...(item.label ? { label: episodeLabel(item.season, item.episode, item.label) } : {}),
      },
      this.streams.bingeGroupOf(dto.optionId),
    );
  }

  /** Plays the first entry that has a playable source; entries without one are dropped. */
  async playQueued(): Promise<boolean> {
    for (let q = this.queue.shift(); q; q = this.queue.shift()) {
      const { entry, bingeGroup } = q;
      const optionId = await this.streams.findMatching(entry.type, entry.videoId, bingeGroup);
      if (!optionId) {
        this.logger.warn(`Dropped ${entry.name} from the queue: no playable source`);
        continue;
      }
      await this.play({ optionId, title: { type: entry.type, id: entry.videoId } });
      return true;
    }
    return false;
  }

  private async advanceQueue(): Promise<void> {
    try {
      await this.playQueued();
    } catch (e) {
      this.logger.warn(`Could not play the next queued item: ${(e as Error).message}`);
    }
  }

  async play(dto: StreamPlayDto): Promise<void> {
    const item = dto.title
      ? await this.catalog.contextOrUndefined(dto.title.type, dto.title.id)
      : undefined;
    const before = item ? await this.tracker.baseline() : undefined;
    // Read before `play`: the option may expire, and `play` can throw.
    const described = item ? this.streams.describeOption(dto.optionId) : undefined;
    await this.streams.play(dto.optionId);
    if (item) {
      if (described) this.remember(item, described);
      const resumeMs = dto.resume === false ? undefined : this.catalog.resumePoint(item.videoId);
      this.tracker.begin(
        item,
        before,
        resumeMs,
        this.streams.bingeGroupOf(dto.optionId),
        dto.optionId,
      );
    }
  }

  /**
   * Looks up what a browser play needs for the library (before the session starts, while the option
   * is still listed). `commit` records the play in the history, so a start that fails leaves
   * nothing behind. Undefined `item` for a play without catalog context or without metadata.
   */
  async prepareBrowser(dto: {
    optionId?: string;
    title?: StreamPlayDto['title'];
    resume?: boolean;
  }): Promise<{ item?: TrackedItem; resumeMs?: number; commit: () => void }> {
    const item = dto.title
      ? await this.catalog.contextOrUndefined(dto.title.type, dto.title.id)
      : undefined;
    if (!item) return { commit: () => undefined };
    // A handoff has no listed option (it may have expired): its play is already in the history.
    const described = dto.optionId ? this.streams.describeOption(dto.optionId) : undefined;
    const group = dto.optionId ? this.streams.bingeGroupOf(dto.optionId) : undefined;
    const resumeMs = dto.resume === false ? undefined : this.catalog.resumePoint(item.videoId);
    return {
      item,
      ...(resumeMs ? { resumeMs } : {}),
      commit: () => {
        if (described) this.remember(item, described);
        if (group) this.catalog.rememberRelease(item.videoId, group);
      },
    };
  }

  /** Saves a position reported by the browser player; a failure never interrupts playback. */
  saveBrowserProgress(item: TrackedItem, positionMs: number, durationMs: number): void {
    try {
      this.catalog.recordProgress({ ...item, positionMs, durationMs });
    } catch (e) {
      this.logger.warn(`Could not save progress: ${(e as Error).message}`);
    }
  }

  private remember(
    item: NonNullable<Awaited<ReturnType<CatalogService['contextOrUndefined']>>>,
    described: OptionDescription,
  ): void {
    try {
      this.history.record({
        id: item.videoId,
        type: item.title.type,
        titleId: item.title.id,
        name: item.title.name,
        ...(item.title.year ? { year: item.title.year } : {}),
        ...(item.title.poster ? { poster: item.title.poster } : {}),
        ...(item.label ? { label: episodeLabel(item.season, item.episode, item.label) } : {}),
        releaseTitle: described.releaseTitle,
        ...(described.resolution ? { resolution: described.resolution } : {}),
        ...(described.quality ? { quality: described.quality } : {}),
        releaseKey: described.releaseKey ?? '',
      });
    } catch (e) {
      this.logger.warn(`Could not record the play in the history: ${(e as Error).message}`);
    }
  }

  /** The last plays still on the list, newest first. */
  recent(): PlaybackHistoryResponse {
    return { items: this.history.list().map(toPlayedItem) };
  }

  /** Starts a history entry again: the same release, found anew with a fresh link (ADR-0005). */
  async replay(id: string): Promise<void> {
    const entry = this.history.get(id);
    if (!entry) throw new NotFoundException('That play is no longer in the history');
    const optionId = await this.streams.findMatching(
      entry.type,
      entry.id,
      entry.releaseKey || undefined,
    );
    if (!optionId) {
      throw new NoMatchingSourceError('No playable source from the same release');
    }
    await this.play({ optionId, title: { type: entry.type, id: entry.id } });
  }

  /** The release last played for this video, so the list can flag it. */
  lastReleaseOf(videoId: string): string | undefined {
    return this.catalog.lastReleaseOf(videoId);
  }

  /** The aired episodes around the last one played from the catalog. */
  async neighbors(): Promise<AdjacentEpisodes> {
    const last = this.tracker.lastPlay();
    if (!last || last.item.season === undefined) return {};
    return this.catalog.neighbors(last.item.videoId);
  }

  /** Plays the next episode from the same release group as the last one. */
  playNext(): Promise<void> {
    return this.playAdjacent('next');
  }

  /** Plays the previous episode, from the same release group, from its start. */
  playPrevious(): Promise<void> {
    return this.playAdjacent('previous');
  }

  /**
   * Finds the source of the episode before or after `videoId`, from the same release (`bingeGroup`).
   * The same lookup serves the TV and the browser player; each starts what it finds its own way.
   */
  async findAdjacent(
    from: { videoId: string; season: number | undefined },
    bingeGroup: string | undefined,
    direction: 'next' | 'previous',
  ): Promise<{ optionId: string; videoId: string; label: string }> {
    const target =
      from.season === undefined
        ? undefined
        : (await this.catalog.neighbors(from.videoId))[direction];
    if (!target) throw new NoAdjacentEpisodeError(`There is no ${direction} episode`);
    if (!bingeGroup) {
      throw new NoMatchingSourceError('The last source does not say which release it is from');
    }
    const optionId = await this.streams.findMatching('series', target.videoId, bingeGroup);
    if (!optionId) {
      throw new NoMatchingSourceError(
        `No source from the same release for the ${direction} episode`,
      );
    }
    return { optionId, videoId: target.videoId, label: target.label };
  }

  /** The aired episodes around `videoId`, for a player that shows them. Never throws. */
  async neighborsOf(videoId: string): Promise<AdjacentEpisodes> {
    return this.catalog.neighbors(videoId).catch(() => ({}));
  }

  /** A play in the history, or 404. */
  historyEntry(id: string) {
    const entry = this.history.get(id);
    if (!entry) throw new NotFoundException('That play is no longer in the history');
    return entry;
  }

  private async playAdjacent(direction: 'next' | 'previous'): Promise<void> {
    const last = this.tracker.lastPlay();
    if (!last) throw new NoAdjacentEpisodeError(`There is no ${direction} episode`);
    const found = await this.findAdjacent(
      { videoId: last.item.videoId, season: last.item.season },
      last.bingeGroup,
      direction,
    );
    const target = { videoId: found.videoId };
    const optionId = found.optionId;
    await this.play({
      optionId,
      title: { type: 'series', id: target.videoId },
      ...(direction === 'previous' ? { resume: false } : {}),
    });
    this.logger.log(`Playing the ${direction} episode after ${last.item.title.name}`);
  }

  private async advance(group?: string): Promise<void> {
    try {
      if (group) await this.playNext();
    } catch (e) {
      // The phone can still pick a source by hand; nothing else to do at the end of a film.
      this.logger.log(`No automatic next episode: ${(e as Error).message}`);
    }
  }
}
