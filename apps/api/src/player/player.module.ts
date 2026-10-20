import { Module } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { KodiService } from '../kodi/kodi.service.js';
import { PlayerController } from './player.controller.js';
import { PlayerStatusService } from './player-status.service.js';
import { TrackPreferences } from './track-preferences.service.js';

@Module({
  exports: [PlayerStatusService, TrackPreferences],
  controllers: [PlayerController],
  providers: [
    {
      provide: PlayerStatusService,
      inject: [KodiService],
      useFactory: (kodi: KodiService) => new PlayerStatusService(kodi),
    },
    {
      provide: TrackPreferences,
      inject: [DbService, KodiService, PlayerStatusService],
      useFactory: (db: DbService, kodi: KodiService, status: PlayerStatusService) =>
        new TrackPreferences(db, kodi.commands, () => status.current()),
    },
  ],
})
export class PlayerModule {}
