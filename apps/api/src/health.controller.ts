import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@home-media-cast/shared';
import { Public } from './auth/public.decorator.js';
import { DbService } from './db/db.service.js';
import { KodiService } from './kodi/kodi.service.js';

/** Public on purpose: the PWA shows connection state before the device is paired. */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly kodi: KodiService,
    private readonly db: DbService,
  ) {}

  @Get()
  get(): HealthResponse {
    const kodi = this.kodi.health();
    let db: HealthResponse['db'] = 'ok';
    try {
      this.db.ping();
    } catch {
      db = 'error';
    }
    return { status: kodi.state === 'connected' && db === 'ok' ? 'ok' : 'degraded', kodi, db };
  }
}
