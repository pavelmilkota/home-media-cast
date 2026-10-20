import { Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { PlaybackController } from './playback.controller.js';
import { UrlGuard } from './url-guard.js';

@Module({
  controllers: [PlaybackController],
  providers: [
    {
      provide: UrlGuard,
      useFactory: () => new UrlGuard({ allowHosts: loadConfig().playbackAllowHosts }),
    },
  ],
})
export class PlaybackModule {}
