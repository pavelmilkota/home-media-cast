import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { BrowserPlayModule } from './browser-play/browser-play.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { DbModule } from './db/db.module.js';
import { DomainErrorFilter } from './errors.filter.js';
import { HealthController } from './health.controller.js';
import { KodiModule } from './kodi/kodi.module.js';
import { LogsModule } from './logs/logs.module.js';
import { PairingModule } from './pairing/pairing.module.js';
import { PlaybackModule } from './playback/playback.module.js';
import { PlayerModule } from './player/player.module.js';
import { RelayModule } from './relay/relay.module.js';
import { SourcesModule } from './sources/sources.module.js';
import { TvModule } from './tv/tv.module.js';
import { YoutubeModule } from './youtube/youtube.module.js';

@Module({
  imports: [
    DbModule,
    KodiModule,
    AuthModule,
    PairingModule,
    PlaybackModule,
    PlayerModule,
    YoutubeModule,
    RelayModule,
    SourcesModule,
    BrowserPlayModule,
    CatalogModule,
    TvModule,
    LogsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: DomainErrorFilter }],
})
export class AppModule {}
