import { Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { KodiRestartService } from './kodi-restart.service.js';
import { TvController } from './tv.controller.js';

@Module({
  controllers: [TvController],
  providers: [
    {
      provide: KodiRestartService,
      useFactory: () => new KodiRestartService(loadConfig().kodiRestartTrigger),
    },
  ],
})
export class TvModule {}
