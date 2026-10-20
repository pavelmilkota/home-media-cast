import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { DeviceService } from './device.service.js';
import { DevicesController } from './devices.controller.js';

@Global()
@Module({
  controllers: [DevicesController],
  providers: [DeviceService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [DeviceService],
})
export class AuthModule {}
