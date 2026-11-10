import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
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
    @Req() req: Request,
  ): PairingCompleteResponse {
    // The route is public, so the optional guest bearer is read by hand.
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    return this.pairing.complete(dto.code, dto.deviceName, scheme === 'Bearer' ? token : undefined);
  }
}
