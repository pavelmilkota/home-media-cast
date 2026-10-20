import { Module } from '@nestjs/common';
import { KodiService } from '../kodi/kodi.service.js';
import { PlayerController } from './player.controller.js';
import { PlayerStatusService } from './player-status.service.js';

@Module({
  exports: [PlayerStatusService],
  controllers: [PlayerController],
  providers: [
    {
      provide: PlayerStatusService,
      inject: [KodiService],
      useFactory: (kodi: KodiService) => new PlayerStatusService(kodi),
    },
  ],
})
export class PlayerModule {}
