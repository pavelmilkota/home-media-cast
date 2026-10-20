import { dirname, join } from 'node:path';
import { Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { KodiService } from '../kodi/kodi.service.js';
import { JsonFileDataStore } from './json-file-data-store.js';
import { YoutubeController } from './youtube.controller.js';
import { YoutubeService } from './youtube.service.js';

@Module({
  controllers: [YoutubeController],
  providers: [
    {
      provide: YoutubeService,
      inject: [KodiService],
      useFactory: (kodi: KodiService) => {
        const { youtube, dbPath } = loadConfig();
        const store = new JsonFileDataStore(
          dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'youtube-cast.json'),
        );
        return new YoutubeService(kodi, store, youtube);
      },
    },
  ],
})
export class YoutubeModule {}
