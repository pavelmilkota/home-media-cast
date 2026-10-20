import { Module } from '@nestjs/common';
import { AioStreamsClient } from '../aiostreams/aiostreams.client.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { WatchTracker } from '../catalog/watch-tracker.service.js';
import { loadConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { KodiService } from '../kodi/kodi.service.js';
import { RelayService } from '../relay/relay.service.js';
import { QueueService } from './queue.service.js';
import { StreamsCacheStore } from './streams-cache.store.js';
import { StreamsController } from './streams.controller.js';
import { StreamsService } from './streams.service.js';
import { WatchPlayService } from './watch-play.service.js';

@Module({
  imports: [CatalogModule],
  controllers: [StreamsController],
  providers: [
    {
      provide: StreamsCacheStore,
      inject: [DbService],
      useFactory: (db: DbService) => new StreamsCacheStore(db),
    },
    {
      provide: StreamsService,
      inject: [RelayService, KodiService, StreamsCacheStore],
      useFactory: (relay: RelayService, kodi: KodiService, cache: StreamsCacheStore) => {
        const { aiostreams } = loadConfig();
        return new StreamsService(
          aiostreams ? new AioStreamsClient(aiostreams) : undefined,
          relay,
          kodi,
          cache,
        );
      },
    },
    { provide: QueueService, useFactory: () => new QueueService() },
    {
      provide: WatchPlayService,
      inject: [StreamsService, CatalogService, WatchTracker, QueueService],
      useFactory: (s: StreamsService, c: CatalogService, t: WatchTracker, q: QueueService) =>
        new WatchPlayService(s, c, t, q, { autoNext: loadConfig().autoNextEpisode }),
    },
  ],
})
export class SourcesModule {}
