import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { AppLogResponse, KodiLogResponse } from '@home-media-cast/shared';
import { AppLogBuffer } from './app-log.buffer.js';
import { KodiLogService, MAX_KODI_LOG_LINES } from './kodi-log.service.js';

/** Recent errors from this API and the tail of Kodi's log, both redacted. */
@Controller('logs')
export class LogsController {
  constructor(
    private readonly app: AppLogBuffer,
    private readonly kodi: KodiLogService,
  ) {}

  @Get('app')
  appLog(): AppLogResponse {
    return { entries: this.app.entries() };
  }

  @Get('kodi')
  kodiLog(@Query('lines') lines?: string): Promise<KodiLogResponse> {
    if (lines !== undefined && !/^-?\d+$/.test(lines)) {
      throw new BadRequestException('lines must be an integer');
    }
    return this.kodi.tail(lines === undefined ? MAX_KODI_LOG_LINES : Number(lines));
  }
}
