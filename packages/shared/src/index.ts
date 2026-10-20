export type HealthStatus = 'ok' | 'degraded';

export interface KodiHealth {
  state: 'connected' | 'reconnecting' | 'unreachable';
  /** JSON-RPC API version, e.g. "13.5.0"; absent while unreachable. */
  version?: string;
}

export interface HealthResponse {
  status: HealthStatus;
  kodi: KodiHealth;
  db: 'ok' | 'error';
}

export * from './schemas.js';

export * from './player.js';

export * from './youtube.js';

export * from './streams.js';

export * from './catalog.js';
