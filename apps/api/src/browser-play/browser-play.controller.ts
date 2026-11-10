import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  BrowserCapsSchema,
  ExternalFromSessionSchema,
  ExternalStartSchema,
  BrowserAudioSchema,
  BrowserSubtitleSchema,
  BrowserProgressSchema,
  BrowserPlayerErrorSchema,
  BrowserSeekSchema,
  BrowserStartSchema,
  type BrowserCapsDto,
  type ExternalFromSessionDto,
  type ExternalSession,
  type ExternalStartDto,
  type BrowserAudioDto,
  type BrowserPlayConfig,
  type BrowserSubtitleDto,
  type BrowserProgressDto,
  type BrowserPlayerErrorDto,
  type BrowserSeekDto,
  type BrowserSession,
  type BrowserStartDto,
} from '@home-media-cast/shared';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { BrowserSessionService } from './browser-session.service.js';
import { ExternalSessionService } from './external-session.service.js';
import { SessionCoordinator } from './session-coordinator.js';
import { GuestAllowed } from '../auth/guest-allowed.decorator.js';

/** Control routes of the browser player. Every one checks the session belongs to the caller. */
@GuestAllowed()
@Controller('browser-play')
export class BrowserPlayController {
  constructor(
    private readonly sessions: BrowserSessionService,
    private readonly coordinator: SessionCoordinator,
    private readonly external: ExternalSessionService,
  ) {}

  /** What the picker needs to label sources: whether unplayable video is converted. */
  @Get('config')
  config(): BrowserPlayConfig {
    return { transcode: this.sessions.transcodeEnabled };
  }

  /**
   * Hands a listed source to an external player (VLC and the like) on this device. The answer is
   * the LAN path to open; the session starts when the player first reads the file.
   */
  @Post('external')
  startExternal(
    @Req() req: AuthedRequest,
    @Body({ schema: ExternalStartSchema }) dto: ExternalStartDto,
  ): Promise<ExternalSession> {
    return this.external.startFromOption(req.device.id, dto, req.device.kind === 'guest');
  }

  /** Ends an external session. The player's stream fails, which is the only way to stop it. */
  @Delete('external/:id')
  @HttpCode(204)
  endExternal(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    return this.external.endOwned(id, req.device.id);
  }

  /** Starts playing a listed source in this browser. 409 `browser_unsupported` if it cannot. */
  @Post()
  start(
    @Req() req: AuthedRequest,
    @Body({ schema: BrowserStartSchema }) dto: BrowserStartDto,
  ): Promise<BrowserSession> {
    return this.sessions.start(req.device.id, dto, req.device.kind === 'guest');
  }

  /** Starts a new run at `positionMs`; the old playlist stops being served. */
  @Post(':id/seek')
  @HttpCode(200)
  seek(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserSeekSchema }) dto: BrowserSeekDto,
  ): Promise<BrowserSession> {
    return this.sessions.seek(id, req.device.id, dto.positionMs);
  }

  /**
   * The player's first `playing` event: this session is now the household's, and whatever else
   * played (the TV, another browser) stops.
   */
  @Post(':id/started')
  @HttpCode(204)
  started(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    return this.coordinator.confirmStarted(id, req.device.id);
  }

  /** Saves where the player is. Sent every few seconds, on pause and when the page is hidden. */
  @Post(':id/progress')
  @HttpCode(204)
  progress(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserProgressSchema }) dto: BrowserProgressDto,
  ): void {
    this.sessions.progress(id, req.device.id, dto.positionMs);
  }

  /** The player failed: logged, and a copy session that the browser cannot decode converts. */
  @Post(':id/error')
  @HttpCode(204)
  playerError(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserPlayerErrorSchema }) dto: BrowserPlayerErrorDto,
  ): void {
    this.sessions.playerError(id, req.device.id, dto);
  }

  /** Plays the next episode of the same release; this session ends and a new one is returned. */
  @Post(':id/next')
  @HttpCode(200)
  next(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserCapsSchema }) dto: BrowserCapsDto,
  ): Promise<BrowserSession> {
    return this.sessions.skip(id, req.device.id, 'next', dto.caps);
  }

  /** Plays the previous episode of the same release from its start. */
  @Post(':id/previous')
  @HttpCode(200)
  previous(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserCapsSchema }) dto: BrowserCapsDto,
  ): Promise<BrowserSession> {
    return this.sessions.skip(id, req.device.id, 'previous', dto.caps);
  }

  /** Opens what this browser session plays in an external player, from where it is now. */
  @Post(':id/external')
  startExternalFromSession(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: ExternalFromSessionSchema }) dto: ExternalFromSessionDto,
  ): Promise<ExternalSession> {
    const source = this.sessions.sourceOf(id, req.device.id);
    return this.external.start(req.device.id, {
      classified: source.classified,
      ...(source.optionId ? { optionId: source.optionId } : {}),
      title: source.title,
      startMs: dto.startMs ?? source.positionMs,
      ...(req.device.kind === 'guest' ? { guest: true } : {}),
    });
  }

  /** Plays another audio track: a new run at the same position. */
  @Post(':id/audio')
  @HttpCode(200)
  audio(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserAudioSchema }) dto: BrowserAudioDto,
  ): Promise<BrowserSession> {
    return this.sessions.setAudio(id, req.device.id, dto.index, dto.positionMs);
  }

  /** Remembers the subtitle track picked in the player, for the next file. */
  @Post(':id/subtitle')
  @HttpCode(204)
  subtitle(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserSubtitleSchema }) dto: BrowserSubtitleDto,
  ): void {
    this.sessions.setSubtitle(id, req.device.id, dto.index);
  }

  @Delete(':id')
  @HttpCode(204)
  end(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    return this.sessions.endOwned(id, req.device.id);
  }
}
