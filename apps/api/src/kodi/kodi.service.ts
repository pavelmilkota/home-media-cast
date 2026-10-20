import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { KodiHealth } from '@home-media-cast/shared';
import { KodiClient } from './kodi.client.js';
import { KodiCommands } from './kodi.commands.js';
import type { KodiClientOptions } from './kodi.types.js';

export const DEFAULT_KODI_URL = 'ws://127.0.0.1:9090/jsonrpc';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Kodi's JSON-RPC has no authentication, so the backend only ever talks to a local Kodi. */
export function assertLoopbackKodiUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'ws:' || !LOOPBACK.has(url.hostname)) {
    throw new Error(`KODI_WS_URL must be a ws:// URL on loopback, got host "${url.hostname}"`);
  }
  return url.href;
}

@Injectable()
export class KodiService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KodiService.name);
  private readonly client: KodiClient;
  readonly commands: KodiCommands;
  private apiVersion: string | undefined;

  constructor(options: Partial<KodiClientOptions> = {}) {
    const url = assertLoopbackKodiUrl(
      options.url ?? process.env['KODI_WS_URL'] ?? DEFAULT_KODI_URL,
    );
    this.client = new KodiClient({ ...options, url });
    this.commands = new KodiCommands(this.client);
  }

  onModuleInit(): void {
    this.client.on('state', (state) => {
      this.logger.log(`Kodi ${state}`);
      if (state === 'connected') void this.readVersion();
      else this.apiVersion = undefined;
    });
    this.client.start();
  }

  onModuleDestroy(): void {
    this.client.stop();
  }

  get events(): KodiClient {
    return this.client;
  }

  health(): KodiHealth {
    const state = this.client.state;
    return state === 'connected' && this.apiVersion
      ? { state, version: this.apiVersion }
      : { state };
  }

  private async readVersion(): Promise<void> {
    try {
      const { version: v } = await this.client.request<{
        version: { major: number; minor: number; patch: number };
      }>('JSONRPC.Version');
      this.apiVersion = `${v.major}.${v.minor}.${v.patch}`;
    } catch (e) {
      this.logger.warn(`Could not read Kodi API version: ${(e as Error).message}`);
    }
  }
}
