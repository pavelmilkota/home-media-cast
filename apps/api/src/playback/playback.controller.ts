import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  PlaybackSchema,
  YoutubePlaybackSchema,
  parseYouTubeUrl,
  type PlaybackDto,
  type YoutubePlaybackDto,
} from '@home-media-cast/shared';
import { KodiService } from '../kodi/kodi.service.js';
import { UrlGuard, UrlRejectedError } from './url-guard.js';
import { openYouTube } from './youtube-start.js';

@Controller('playback')
export class PlaybackController {
  constructor(
    private readonly guard: UrlGuard,
    private readonly kodi: KodiService,
  ) {}

  /** Starts a user-pasted direct link. The URL is checked first; Kodi never sees a rejected one. */
  @Post()
  @HttpCode(202)
  async play(@Body({ schema: PlaybackSchema }) dto: PlaybackDto): Promise<{ status: 'accepted' }> {
    const url = await this.guard.check(dto.url);
    await this.kodi.commands.open(url, { resume: dto.resume ?? false });
    return { status: 'accepted' };
  }

  /**
   * Plays a pasted or shared YouTube link through the Kodi YouTube addon. Only the video id
   * (and a start offset) is taken from the link; the `plugin://` URL is built by the backend,
   * so the link never reaches Kodi and needs no SSRF check.
   */
  @Post('youtube')
  @HttpCode(202)
  async playYouTube(
    @Body({ schema: YoutubePlaybackSchema }) dto: YoutubePlaybackDto,
  ): Promise<{ status: 'accepted' }> {
    const link = parseYouTubeUrl(dto.url);
    if (!link) throw new UrlRejectedError('That is not a YouTube video link');
    await openYouTube(this.kodi, link.videoId, link.startSeconds);
    return { status: 'accepted' };
  }
}
