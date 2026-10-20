import { Module } from '@nestjs/common';
import { DeviceService } from '../auth/device.service.js';
import { KodiService } from '../kodi/kodi.service.js';
import { PairingController } from './pairing.controller.js';
import { PairingService } from './pairing.service.js';

@Module({
  controllers: [PairingController],
  providers: [
    {
      provide: PairingService,
      inject: [KodiService, DeviceService],
      useFactory: (kodi: KodiService, devices: DeviceService) => new PairingService(kodi, devices),
    },
  ],
})
export class PairingModule {}
