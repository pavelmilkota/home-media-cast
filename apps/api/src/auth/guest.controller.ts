import { Body, Controller, HttpCode, HttpException, HttpStatus, Post } from '@nestjs/common';
import {
  GuestRegisterSchema,
  type GuestRegisterDto,
  type PairingCompleteResponse,
} from '@home-media-cast/shared';
import { DeviceService } from './device.service.js';
import { GuestDisabledError } from './guest.errors.js';
import { Public } from './public.decorator.js';

export const GUEST_LIMIT = 10;
export const GUEST_WINDOW_MS = 60_000;

/**
 * An unpaired device registers itself and gets a limited token (ADR-0009). Public, so a global
 * limit stands in for per-device ones: at most 10 registrations a minute for everyone.
 */
@Public()
@Controller('guest')
export class GuestController {
  private recent: number[] = [];

  /** Replaced in tests. */
  now: () => number = Date.now;

  constructor(private readonly devices: DeviceService) {}

  @Post()
  @HttpCode(200)
  register(@Body({ schema: GuestRegisterSchema }) dto: GuestRegisterDto): PairingCompleteResponse {
    if (!this.devices.guestEnabled) throw new GuestDisabledError();
    const now = this.now();
    this.recent = this.recent.filter((at) => now - at < GUEST_WINDOW_MS);
    if (this.recent.length >= GUEST_LIMIT) {
      throw new HttpException(
        'Too many new devices, try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.recent.push(now);
    return this.devices.createGuest(dto.deviceName, now);
  }
}
