import { Controller, HttpCode, Post } from '@nestjs/common';
import { KodiService } from '../kodi/kodi.service.js';
import { KodiRestartService } from './kodi-restart.service.js';

/** What the TV itself can do besides playing: its window and its process. */
@Controller('tv')
export class TvController {
  constructor(
    private readonly kodi: KodiService,
    private readonly restart: KodiRestartService,
  ) {}

  @Post('fullscreen')
  @HttpCode(204)
  fullscreen(): Promise<void> {
    return this.kodi.commands.toggleFullscreen();
  }

  @Post('home')
  @HttpCode(204)
  home(): Promise<void> {
    return this.kodi.commands.showHome();
  }

  @Post('screensaver')
  @HttpCode(204)
  screensaver(): Promise<void> {
    return this.kodi.commands.activateScreensaver();
  }

  /** 202: the request is written, Kodi is not back yet. */
  @Post('restart-kodi')
  @HttpCode(202)
  async restartKodi(): Promise<{ status: 'requested' }> {
    await this.restart.request();
    return { status: 'requested' };
  }
}
