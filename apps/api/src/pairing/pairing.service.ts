import { randomInt, timingSafeEqual } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PairingCompleteResponse } from '@home-media-cast/shared';
import { DeviceService } from '../auth/device.service.js';
import { KodiService } from '../kodi/kodi.service.js';

export const CODE_TTL_MS = 5 * 60_000;
export const START_COOLDOWN_MS = 10_000;
export const MAX_ATTEMPTS = 5;
const NOTIFICATION_MS = 60_000;

interface PendingCode {
  code: string;
  expiresAt: number;
  attemptsLeft: number;
}

/**
 * Pairing proves the user is in the room: the code appears only on the projector. One code
 * is pending at a time; a wrong guess burns an attempt and 5 of them cancel the code.
 */
@Injectable()
export class PairingService {
  private pending: PendingCode | undefined;
  private lastStartAt = 0;

  constructor(
    private readonly kodi: KodiService,
    private readonly devices: DeviceService,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<{ expiresInSeconds: number }> {
    const now = this.now();
    if (now - this.lastStartAt < START_COOLDOWN_MS) {
      throw new HttpException(
        'Wait a few seconds before asking for a new code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.lastStartAt = now;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      await this.kodi.commands.showNotification(
        'Home Media Cast pairing',
        `Code: ${code}`,
        NOTIFICATION_MS,
      );
    } catch {
      // Never leave a code the user cannot see; it would only be guessable.
      throw new ServiceUnavailableException('Kodi is not reachable, so the code cannot be shown');
    }
    this.pending = { code, expiresAt: now + CODE_TTL_MS, attemptsLeft: MAX_ATTEMPTS };
    return { expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  complete(code: string, deviceName: string): PairingCompleteResponse {
    const pending = this.pending;
    const now = this.now();
    if (!pending || now > pending.expiresAt) {
      this.pending = undefined;
      throw new UnauthorizedException('Invalid or expired code');
    }
    const a = Buffer.from(code);
    const b = Buffer.from(pending.code);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      if (--pending.attemptsLeft <= 0) this.pending = undefined;
      throw new UnauthorizedException('Invalid or expired code');
    }
    this.pending = undefined; // single use
    return this.devices.create(deviceName, now);
  }
}
