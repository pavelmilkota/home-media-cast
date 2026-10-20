import { Controller, Delete, Get, HttpCode, NotFoundException, Param, Req } from '@nestjs/common';
import type { DeviceInfo } from '@home-media-cast/shared';
import type { AuthedRequest } from './auth.guard.js';
import { DeviceService } from './device.service.js';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DeviceService) {}

  @Get()
  list(@Req() req: AuthedRequest): DeviceInfo[] {
    return this.devices.list(req.device.id);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(@Param('id') id: string): void {
    if (!this.devices.revoke(id)) throw new NotFoundException('No such device');
  }
}
