import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  StreamPlaySchema,
  QueueAddSchema,
  type QueueAddDto,
  type QueueEntry,
  type QueueResponse,
  type StreamPlayDto,
  type AdjacentEpisodes,
  type AudioProbeResponse,
  type StreamsCacheCleared,
  type StreamsCacheStats,
  type StreamsResponse,
} from '@home-media-cast/shared';
import { isValidTitleId, type TitleType } from '../aiostreams/aiostreams.client.js';
import { StreamsService } from './streams.service.js';
import { WatchPlayService } from './watch-play.service.js';

@Controller()
export class StreamsController {
  constructor(
    private readonly streams: StreamsService,
    private readonly watchPlay: WatchPlayService,
  ) {}

  /**
   * The sources for a title. Never contains a URL (see `StreamOption`). A cached list is served
   * at once and updated in the background; `?refresh=1` forces an update. The source played last
   * for this video, if any, is listed first and flagged `lastUsed`.
   */
  @Get('titles/:type/:id/streams')
  list(
    @Param('type') type: string,
    @Param('id') id: string,
    @Query('refresh') refresh?: string,
  ): Promise<StreamsResponse> {
    if ((type !== 'movie' && type !== 'series') || !isValidTitleId(type as TitleType, id)) {
      throw new BadRequestException(
        'Expected movie|series and an id like tt0111161 (series: tt0111161:1:4)',
      );
    }
    const lastRelease = this.watchPlay.lastReleaseOf(id);
    return this.streams.list(type as TitleType, id, {
      refresh: refresh === '1' || refresh === 'true',
      ...(lastRelease ? { lastRelease } : {}),
    });
  }

  /**
   * Reads the real audio tracks of one listed source from the start of its file, and keeps them
   * so later lists show them at once. 410 when the option id is no longer known.
   */
  @Get('streams/options/:id/audio')
  audio(@Param('id') id: string): Promise<AudioProbeResponse> {
    return this.streams.probeAudio(id);
  }

  /** How many source lists are cached, and how old the oldest is. */
  @Get('streams/cache')
  cacheStats(): StreamsCacheStats {
    return this.streams.cacheStats();
  }

  /** Forgets every cached source list; the next open of a title searches from scratch. */
  @Delete('streams/cache')
  clearCache(): StreamsCacheCleared {
    return { cleared: this.streams.clearCache() };
  }

  @Post('playback/stream')
  @HttpCode(202)
  async play(
    @Body({ schema: StreamPlaySchema }) dto: StreamPlayDto,
  ): Promise<{ status: 'accepted' }> {
    await this.watchPlay.play(dto);
    return { status: 'accepted' };
  }

  /** The episodes before and after the last one played from the catalog. */
  @Get('playback/episodes')
  async episodes(): Promise<AdjacentEpisodes> {
    return this.watchPlay.neighbors().catch(() => ({}));
  }

  /** Plays the next episode, from the same release group as the last one. */
  @Post('playback/next')
  @HttpCode(202)
  async playNext(): Promise<{ status: 'accepted' }> {
    await this.watchPlay.playNext();
    return { status: 'accepted' };
  }

  /** Plays the previous episode from its start, from the same release group. */
  @Post('playback/previous')
  @HttpCode(202)
  async playPrevious(): Promise<{ status: 'accepted' }> {
    await this.watchPlay.playPrevious();
    return { status: 'accepted' };
  }

  @Get('queue')
  queue(): QueueResponse {
    return { items: this.watchPlay.queue.list() };
  }

  @Post('queue')
  @HttpCode(201)
  enqueue(@Body({ schema: QueueAddSchema }) dto: QueueAddDto): Promise<QueueEntry> {
    return this.watchPlay.enqueue(dto);
  }

  /** Plays the first queued item now. */
  @Post('queue/next')
  @HttpCode(202)
  async playQueued(): Promise<{ status: 'accepted' }> {
    if (!(await this.watchPlay.playQueued())) throw new NotFoundException('The queue is empty');
    return { status: 'accepted' };
  }

  @Delete('queue')
  @HttpCode(204)
  clearQueue(): void {
    this.watchPlay.queue.clear();
  }

  @Delete('queue/:id')
  @HttpCode(204)
  removeQueued(@Param('id') id: string): void {
    if (!this.watchPlay.queue.remove(id)) throw new NotFoundException('Not in the queue');
  }
}
