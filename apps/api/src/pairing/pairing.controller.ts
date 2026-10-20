import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  PairingCompleteSchema,
  type PairingCompleteDto,
  type PairingCompleteResponse,
} from '@home-media-cast/shared';
import { Public } from '../auth/public.decorator.js';
import { PairingService } from './pairing.service.js';

@Public()
@Controller('pairing')
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  @Post('start')
  @HttpCode(200)
  start(): Promise<{ expiresInSeconds: number }> {
    return this.pairing.start();
  }

  @Post('complete')
  @HttpCode(200)
  complete(
    @Body({ schema: PairingCompleteSchema }) dto: PairingCompleteDto,
  ): PairingCompleteResponse {
    return this.pairing.complete(dto.code, dto.deviceName);
  }
}
