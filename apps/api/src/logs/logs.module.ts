import { Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { AppLogBuffer } from './app-log.buffer.js';
import { KodiLogService } from './kodi-log.service.js';
import { LogsController } from './logs.controller.js';

@Module({
  controllers: [LogsController],
  providers: [
    { provide: AppLogBuffer, useFactory: () => AppLogBuffer.shared() },
    { provide: KodiLogService, useFactory: () => new KodiLogService(loadConfig().kodiLogDir) },
  ],
})
export class LogsModule {}
