import { Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { KodiService } from '../kodi/kodi.service.js';
import { PlayerModule } from '../player/player.module.js';
import { PlayerStatusService } from '../player/player-status.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CinemetaClient } from './cinemeta.client.js';
import { LibraryService } from './library.service.js';
import { WatchTracker } from './watch-tracker.service.js';

@Module({
  imports: [PlayerModule],
  controllers: [CatalogController],
  providers: [
    {
      provide: CinemetaClient,
      useFactory: () => new CinemetaClient({ baseUrl: loadConfig().cinemetaUrl }),
    },
    {
      provide: LibraryService,
      inject: [DbService],
      useFactory: (db: DbService) => new LibraryService(db),
    },
    {
      provide: CatalogService,
      inject: [CinemetaClient, LibraryService],
      useFactory: (m: CinemetaClient, l: LibraryService) => new CatalogService(m, l),
    },
    {
      provide: WatchTracker,
      inject: [PlayerStatusService, LibraryService, KodiService],
      useFactory: (p: PlayerStatusService, l: LibraryService, k: KodiService) =>
        new WatchTracker(p, l, (positionMs) => k.commands.seek({ positionMs })),
    },
  ],
  exports: [CatalogService, WatchTracker],
})
export class CatalogModule {}
