import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  BrowseQuerySchema,
  TitleStateSchema,
  type BrowseResponse,
  WatchedSchema,
  type LibraryResponse,
  type SearchResponse,
  type TitleDetail,
  type TitleState,
  type TitleStateDto,
  type WatchedDto,
} from '@home-media-cast/shared';
import { KodiService } from '../kodi/kodi.service.js';
import { openYouTube } from '../playback/youtube-start.js';
import { CatalogService, parseVideoId } from './catalog.service.js';
import { isImdbId } from './cinemeta.client.js';
import { LibraryService } from './library.service.js';

function checkTitle(type: string, id: string): asserts type is 'movie' | 'series' {
  if ((type !== 'movie' && type !== 'series') || !isImdbId(id)) {
    throw new BadRequestException('Expected movie|series and an id like tt0111161');
  }
}

@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly library: LibraryService,
    private readonly kodi: KodiService,
  ) {}

  @Get('catalog/search')
  search(@Query('q') q?: string): Promise<SearchResponse> {
    const query = (q ?? '').trim();
    if (query.length < 2 || query.length > 100) {
      throw new BadRequestException('Type 2 to 100 characters');
    }
    return this.catalog.search(query);
  }

  @Get('catalog/discover')
  discover(): Promise<SearchResponse> {
    return this.catalog.discover();
  }

  @Get('catalog/browse')
  browse(@Query() query: Record<string, unknown>): Promise<BrowseResponse> {
    const parsed = BrowseQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    return this.catalog.browse(parsed.data);
  }

  @Get('catalog/:type/:id')
  detail(@Param('type') type: string, @Param('id') id: string): Promise<TitleDetail> {
    checkTitle(type, id);
    return this.catalog.detail(type, id);
  }

  /**
   * Plays the title's trailer through the Kodi YouTube addon. The video id comes from the
   * metadata the backend fetched itself, never from the client.
   */
  @Post('catalog/:type/:id/trailer')
  @HttpCode(202)
  async playTrailer(
    @Param('type') type: string,
    @Param('id') id: string,
  ): Promise<{ status: 'accepted' }> {
    checkTitle(type, id);
    const videoId = await this.catalog.trailerId(type, id);
    if (!videoId) throw new NotFoundException('No trailer available');
    await openYouTube(this.kodi, videoId);
    return { status: 'accepted' };
  }

  @Put('catalog/:type/:id/state')
  setState(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body({ schema: TitleStateSchema }) dto: TitleStateDto,
  ): Promise<TitleState> {
    checkTitle(type, id);
    return this.catalog.setState(type, id, dto);
  }

  /** `videoId` is a movie id, or `tt…:season:episode`. */
  @Put('catalog/:type/watched/:videoId')
  @HttpCode(204)
  async setWatched(
    @Param('type') type: string,
    @Param('videoId') videoId: string,
    @Body({ schema: WatchedSchema }) dto: WatchedDto,
  ): Promise<void> {
    const parsed = parseVideoId(videoId);
    if (!parsed) throw new BadRequestException('Not a valid video id');
    checkTitle(type, parsed.titleId);
    try {
      await this.catalog.setWatched(type, videoId, dto.watched);
    } catch (e) {
      if (e instanceof RangeError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Every aired episode of one season; season 0 holds specials. */
  @Put('catalog/series/:id/seasons/:season/watched')
  @HttpCode(204)
  async setSeasonWatched(
    @Param('id') id: string,
    @Param('season') season: string,
    @Body({ schema: WatchedSchema }) dto: WatchedDto,
  ): Promise<void> {
    checkTitle('series', id);
    if (!/^\d{1,3}$/.test(season)) throw new BadRequestException('Not a valid season');
    await this.catalog.setSeasonWatched(id, Number(season), dto.watched);
  }

  @Get('library')
  overview(): LibraryResponse {
    return this.library.overview();
  }
}
