import { Body, Controller, Get, HttpCode, type MessageEvent, Post, Sse } from '@nestjs/common';
import {
  AudioSchema,
  SeekSchema,
  SubtitleSchema,
  VolumeSchema,
  type AudioDto,
  type PlayerStatus,
  type SeekTarget,
  type SubtitleDto,
  type VolumeDto,
} from '@home-media-cast/shared';
import { Observable, map, merge, interval } from 'rxjs';
import { KodiService } from '../kodi/kodi.service.js';
import { PlayerStatusService } from './player-status.service.js';

@Controller()
export class PlayerController {
  constructor(
    private readonly kodi: KodiService,
    private readonly status: PlayerStatusService,
  ) {}

  @Get('player/status')
  getStatus(): Promise<PlayerStatus> {
    return this.status.current();
  }

  @Post('player/pause')
  @HttpCode(204)
  pause(): Promise<void> {
    return this.kodi.commands.playPause(false);
  }

  @Post('player/resume')
  @HttpCode(204)
  resume(): Promise<void> {
    return this.kodi.commands.playPause(true);
  }

  @Post('player/stop')
  @HttpCode(204)
  stop(): Promise<void> {
    return this.kodi.commands.stop();
  }

  @Post('player/seek')
  @HttpCode(204)
  seek(@Body({ schema: SeekSchema }) target: SeekTarget): Promise<void> {
    return this.kodi.commands.seek(target);
  }

  @Post('player/volume')
  @HttpCode(204)
  volume(@Body({ schema: VolumeSchema }) dto: VolumeDto): Promise<void> {
    return this.kodi.commands.setVolume(dto.volume);
  }

  @Post('player/audio')
  @HttpCode(204)
  audio(@Body({ schema: AudioSchema }) dto: AudioDto): Promise<void> {
    return this.kodi.commands.setAudioStream(dto.index);
  }

  @Post('player/subtitle')
  @HttpCode(204)
  subtitle(@Body({ schema: SubtitleSchema }) dto: SubtitleDto): Promise<void> {
    return this.kodi.commands.setSubtitle(dto.index);
  }

  /**
   * Server-sent events. EventSource cannot send an Authorization header, so the PWA reads
   * this with fetch(); the token never goes into the URL, where it would end up in logs.
   */
  @Sse('events')
  events(): Observable<MessageEvent> {
    const events = this.status
      .stream()
      .pipe(map((e): MessageEvent => ({ type: e.type, data: e.data })));
    // A comment-like heartbeat keeps proxies and phones from closing an idle stream.
    const heartbeat = interval(15_000).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));
    return merge(events, heartbeat);
  }
}
