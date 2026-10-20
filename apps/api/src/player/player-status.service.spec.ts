import type { PlayerEvent } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KodiService } from '../kodi/kodi.service.js';
import { FakeKodiServer } from '../kodi/testing/fake-kodi.server.js';
import { PlayerStatusService } from './player-status.service.js';

const time = (s: number) => ({ hours: 0, minutes: 0, seconds: s, milliseconds: 0 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PlayerStatusService', () => {
  let kodi: FakeKodiServer;
  let kodiService: KodiService;
  let service: PlayerStatusService;
  let speed: number;

  beforeEach(async () => {
    speed = 1;
    kodi = new FakeKodiServer();
    await kodi.start();
    kodi
      .on('JSONRPC.Version', { version: { major: 13, minor: 5, patch: 0 } })
      .on('Application.GetProperties', { volume: 40, muted: false })
      .on('Player.GetActivePlayers', [{ playerid: 1, playertype: 'internal', type: 'video' }])
      .onCall('Player.GetProperties', () => ({
        speed,
        time: time(10),
        totaltime: time(100),
        audiostreams: [],
        currentaudiostream: null,
        subtitles: [],
        currentsubtitle: null,
        subtitleenabled: false,
      }))
      .on('Player.GetItem', { item: { label: 'movie.mkv', type: 'unknown' } });
    kodiService = new KodiService({ url: kodi.url, reconnectInitialDelayMs: 20 });
    // A long debounce on purpose: it opens the window the race needs.
    service = new PlayerStatusService(kodiService, { pollIntervalMs: 5_000, debounceMs: 300 });
    kodiService.onModuleInit();
    service.onModuleInit();
    for (let i = 0; i < 200 && kodiService.health().version === undefined; i++) await sleep(10);
  });

  afterEach(async () => {
    service.onModuleDestroy();
    kodiService.onModuleDestroy();
    await kodi.stop();
  });

  it('delivers a change to SSE subscribers even if a status GET happens before the debounced refresh', async () => {
    const seen: PlayerEvent[] = [];
    const sub = service.stream().subscribe((e) => seen.push(e));
    await service.current(); // phone A is playing and has been published
    await sleep(350);
    seen.length = 0;

    speed = 0;
    kodi.notify('Player.OnPause', {}); // starts the 300 ms debounce
    await sleep(50);
    await service.current(); // phone B refetches inside the debounce window
    await sleep(450);

    const statuses = seen.filter((e) => e.type === 'status');
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses.at(-1)?.data).toMatchObject({ active: true, speed: 0 });
    sub.unsubscribe();
  });

  it('does not read Kodi while nobody listens', async () => {
    const before = kodi.requests.length;
    kodi.notify('Player.OnPause', {});
    await sleep(450);
    expect(kodi.requests.length).toBe(before);
  });
});
