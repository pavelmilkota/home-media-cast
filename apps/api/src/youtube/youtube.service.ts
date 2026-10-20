import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import YouTubeCastReceiver, { type DataStore } from 'yt-cast-receiver';
import type { YoutubeCastStatus } from '@home-media-cast/shared';
import type { KodiService } from '../kodi/kodi.service.js';
import { KodiYouTubePlayer } from './kodi-youtube.player.js';
import { ReceiverLogger } from './receiver-logger.js';

/** What the service needs from the receiver library; tests substitute their own. */
export interface CastReceiver {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type ReceiverFactory = (player: KodiYouTubePlayer, store: DataStore) => CastReceiver;

export interface YoutubeServiceOptions {
  /** Initial state of the switch, used until the first change is saved. */
  enabled: boolean;
  dialPort: number;
  deviceName: string;
  receiverFactory?: ReceiverFactory;
}

const ENABLED_KEY = 'hmc.youtubeCastEnabled';

/**
 * Runs the YouTube Cast receiver inside the backend (ADR-0003) behind an on/off switch
 * (ADR-0007). A failed start (port taken, no network) is reported in the status and never
 * stops the rest of the backend.
 */
@Injectable()
export class YoutubeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YoutubeService.name);
  private readonly factory: ReceiverFactory;
  private active: { receiver: CastReceiver; player: KodiYouTubePlayer } | undefined;
  private enabled: boolean;
  private error: string | undefined;
  /** Start and stop calls run one after another. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly kodi: KodiService,
    private readonly store: DataStore,
    private readonly options: YoutubeServiceOptions,
  ) {
    this.enabled = options.enabled;
    this.factory =
      options.receiverFactory ??
      ((player, dataStore) =>
        new YouTubeCastReceiver(player, {
          dial: { port: options.dialPort },
          device: { name: options.deviceName },
          dataStore,
          logger: new ReceiverLogger(),
        }));
  }

  async onModuleInit(): Promise<void> {
    this.enabled = (await this.store.get<boolean>(ENABLED_KEY)) ?? this.options.enabled;
    if (this.enabled) await this.apply();
  }

  async onModuleDestroy(): Promise<void> {
    await this.enqueue(() => this.stopReceiver());
  }

  status(): YoutubeCastStatus {
    return {
      enabled: this.enabled,
      running: this.active !== undefined,
      deviceName: this.options.deviceName,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<YoutubeCastStatus> {
    this.enabled = enabled;
    await this.store.set(ENABLED_KEY, enabled);
    await this.apply();
    return this.status();
  }

  private apply(): Promise<void> {
    return this.enqueue(async () => {
      if (this.enabled && !this.active) await this.startReceiver();
      else if (!this.enabled && this.active) await this.stopReceiver();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async startReceiver(): Promise<void> {
    const player = new KodiYouTubePlayer(this.kodi);
    try {
      const receiver = this.factory(player, this.store);
      player.attach();
      await receiver.start();
      this.active = { receiver, player };
      this.error = undefined;
      this.logger.log(`YouTube Cast receiver "${this.options.deviceName}" is up`);
    } catch (e) {
      player.detach();
      this.error = (e as Error).message;
      this.logger.error(`YouTube Cast receiver failed to start: ${this.error}`);
    }
  }

  private async stopReceiver(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.player.detach();
    try {
      await active.receiver.stop();
    } catch (e) {
      this.logger.warn(`YouTube Cast receiver did not stop cleanly: ${(e as Error).message}`);
    }
  }
}
