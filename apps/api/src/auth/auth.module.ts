import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { loadConfig } from '../config.js';
import { DbService } from '../db/db.service.js';
import { AuthGuard } from './auth.guard.js';
import { DeviceService } from './device.service.js';
import { DevicesController } from './devices.controller.js';
import { GuestController } from './guest.controller.js';

@Global()
@Module({
  controllers: [DevicesController, GuestController],
  providers: [
    {
      provide: DeviceService,
      inject: [DbService],
      useFactory: (db: DbService) =>
        new DeviceService(db, { guestEnabled: loadConfig().guestPlaybackEnabled }),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [DeviceService],
})
export class AuthModule {}
