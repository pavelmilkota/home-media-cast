import { Injectable, Logger } from '@nestjs/common';
import type {
  AdjacentEpisodes,
  QueueAddDto,
  QueueEntry,
  StreamPlayDto,
} from '@home-media-cast/shared';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { WatchTracker } from '../catalog/watch-tracker.service.js';
import type { QueueService } from './queue.service.js';
import type { StreamsService } from './streams.service.js';

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
    await this.streams.play(dto.optionId);
    if (item) {
      const resumeMs = dto.resume === false ? undefined : this.catalog.resumePoint(item.videoId);
      this.tracker.begin(item, before, resumeMs, this.streams.bingeGroupOf(dto.optionId));
    }
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

  private async playAdjacent(direction: 'next' | 'previous'): Promise<void> {
    const last = this.tracker.lastPlay();
    const target = (await this.neighbors())[direction];
    if (!last || !target) throw new NoAdjacentEpisodeError(`There is no ${direction} episode`);
    if (!last.bingeGroup) {
      throw new NoMatchingSourceError('The last source does not say which release it is from');
    }
    const optionId = await this.streams.findMatching('series', target.videoId, last.bingeGroup);
    if (!optionId) {
      throw new NoMatchingSourceError(
        `No source from the same release for the ${direction} episode`,
      );
    }
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
