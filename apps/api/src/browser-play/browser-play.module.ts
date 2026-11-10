import { Module } from '@nestjs/common';
import { DeviceService } from '../auth/device.service.js';
import { loadConfig } from '../config.js';
import { RelayService } from '../relay/relay.service.js';
import { SourcesModule } from '../sources/sources.module.js';
import { StreamsService } from '../sources/streams.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { WatchTracker } from '../catalog/watch-tracker.service.js';
import { KodiService } from '../kodi/kodi.service.js';
import { PlayerStatusService } from '../player/player-status.service.js';
import { PlayerModule } from '../player/player.module.js';
import { TrackPreferences } from '../player/track-preferences.service.js';
import { WatchPlayService } from '../sources/watch-play.service.js';
import { BrowserPlayController } from './browser-play.controller.js';
import { BrowserSessionService } from './browser-session.service.js';
import { nodeSpawn, type SpawnFn } from './ffmpeg.js';
import { ExternalSessionService } from './external-session.service.js';
import { SessionHub } from './session-hub.js';
import { HandoffController } from './handoff.controller.js';
import { HandoffService } from './handoff.service.js';
import { MediaController } from './media.controller.js';
import { SessionCoordinator } from './session-coordinator.js';

/** Replaced by a fake in tests. */
export const PROCESS_SPAWN = Symbol('PROCESS_SPAWN');
/** Where run directories live; tests use their own. */
export const MEDIA_DIR = Symbol('MEDIA_DIR');

@Module({
  imports: [SourcesModule, PlayerModule, CatalogModule],
  controllers: [BrowserPlayController, MediaController, HandoffController],
  providers: [
    { provide: PROCESS_SPAWN, useValue: nodeSpawn },
    { provide: MEDIA_DIR, useFactory: () => loadConfig().browserPlay.mediaDir },
    {
      provide: BrowserSessionService,
      inject: [
        StreamsService,
        WatchPlayService,
        RelayService,
        DeviceService,
        TrackPreferences,
        PROCESS_SPAWN,
        MEDIA_DIR,
      ],
      useFactory: (
        streams: StreamsService,
        watch: WatchPlayService,
        relay: RelayService,
        devices: DeviceService,
        tracks: TrackPreferences,
        spawn: SpawnFn,
        mediaDir: string,
      ) => {
        const { aheadSegments, behindSegments, transcode } = loadConfig().browserPlay;
        const service = new BrowserSessionService(streams, relay, {
          spawn,
          mediaDir,
          transcode,
          choices: tracks.choices,
          adjacent: {
            find: (item, key, direction) =>
              watch.findAdjacent({ videoId: item.videoId, season: item.season }, key, direction),
            neighbors: (item) => watch.neighborsOf(item.videoId),
          },
          autoNext: loadConfig().autoNextEpisode,
          deviceName: (id) => devices.nameOf(id),
          progress: {
            prepare: (dto) => watch.prepareBrowser(dto),
            save: (item, positionMs, durationMs) =>
              watch.saveBrowserProgress(item, positionMs, durationMs),
          },
          aheadSegments,
          behindSegments,
        });
        devices.onRevoked((deviceId) => void service.endForDevice(deviceId));
        devices.onPromoted((deviceId) => service.markPaired(deviceId));
        return service;
      },
    },
    {
      provide: ExternalSessionService,
      inject: [StreamsService, WatchPlayService, RelayService, DeviceService, PROCESS_SPAWN],
      useFactory: (
        streams: StreamsService,
        watch: WatchPlayService,
        relay: RelayService,
        devices: DeviceService,
        spawn: SpawnFn,
      ) => {
        const service = new ExternalSessionService(streams, relay, {
          spawn,
          progress: {
            prepare: (dto) => watch.prepareBrowser(dto),
            save: (item, positionMs, durationMs) =>
              watch.saveBrowserProgress(item, positionMs, durationMs),
          },
          deviceName: (id) => devices.nameOf(id),
        });
        devices.onRevoked((deviceId) => void service.endForDevice(deviceId));
        devices.onPromoted((deviceId) => service.markPaired(deviceId));
        return service;
      },
    },
    {
      provide: SessionHub,
      inject: [BrowserSessionService, ExternalSessionService],
      useFactory: (browser: BrowserSessionService, external: ExternalSessionService) => {
        const hub = new SessionHub(browser, external);
        const gate = (deviceId: string) => hub.claimForGuest(deviceId);
        browser.guestGate = gate;
        external.guestGate = gate;
        return hub;
      },
    },
    {
      provide: SessionCoordinator,
      inject: [SessionHub, ExternalSessionService, WatchTracker, KodiService, PlayerStatusService],
      useFactory: (
        hub: SessionHub,
        external: ExternalSessionService,
        tracker: WatchTracker,
        kodi: KodiService,
        status: PlayerStatusService,
      ) => {
        const coordinator = new SessionCoordinator(
          hub,
          { endTracking: () => tracker.end(), stop: () => kodi.commands.stop() },
          status,
        );
        external.onStarted = (id) => coordinator.confirmExternal(id);
        return coordinator;
      },
    },
    {
      provide: HandoffService,
      inject: [
        BrowserSessionService,
        SessionHub,
        StreamsService,
        WatchPlayService,
        WatchTracker,
        PlayerStatusService,
      ],
      useFactory: (
        sessions: BrowserSessionService,
        hub: SessionHub,
        streams: StreamsService,
        watch: WatchPlayService,
        tracker: WatchTracker,
        status: PlayerStatusService,
      ) =>
        new HandoffService(sessions, hub, streams, watch, {
          activePlay: () => tracker.activePlay(),
          status: () => status.current(),
        }),
    },
  ],
})
export class BrowserPlayModule {}
