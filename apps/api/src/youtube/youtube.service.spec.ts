import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KodiService } from '../kodi/kodi.service.js';
import { JsonFileDataStore } from './json-file-data-store.js';
import { type CastReceiver, YoutubeService } from './youtube.service.js';

describe('YoutubeService', () => {
  let kodi: KodiService;
  let store: JsonFileDataStore;
  let events: string[];
  let failStart: Error | undefined;

  const make = (enabled: boolean) =>
    new YoutubeService(kodi, store, {
      enabled,
      dialPort: 3100,
      deviceName: 'homeMediaCast',
      receiverFactory: (): CastReceiver => ({
        start: async () => {
          if (failStart) throw failStart;
          events.push('start');
        },
        stop: async () => {
          events.push('stop');
        },
      }),
    });

  beforeEach(() => {
    kodi = new KodiService({ url: 'ws://127.0.0.1:1/jsonrpc' }); // never started: no connection
    store = new JsonFileDataStore();
    events = [];
    failStart = undefined;
  });
  afterEach(() => undefined);

  it('stays off by default and starts nothing', async () => {
    const s = make(false);
    await s.onModuleInit();
    expect(s.status()).toEqual({ enabled: false, running: false, deviceName: 'homeMediaCast' });
    expect(events).toEqual([]);
  });

  it('starts at boot when the env default is on', async () => {
    const s = make(true);
    await s.onModuleInit();
    expect(s.status()).toMatchObject({ enabled: true, running: true });
    expect(events).toEqual(['start']);
  });

  it('turns on and off from the switch, once each', async () => {
    const s = make(false);
    await s.onModuleInit();
    expect(await s.setEnabled(true)).toMatchObject({ enabled: true, running: true });
    await s.setEnabled(true);
    expect(await s.setEnabled(false)).toMatchObject({ enabled: false, running: false });
    await s.setEnabled(false);
    expect(events).toEqual(['start', 'stop']);
  });

  it('a saved switch beats the env default after a restart', async () => {
    await make(true).setEnabled(false);
    const s = make(true);
    await s.onModuleInit();
    expect(s.status()).toMatchObject({ enabled: false, running: false });
    expect(events).toEqual([]);
  });

  it('reports a failed start without throwing, and can retry', async () => {
    failStart = new Error('EADDRINUSE');
    const s = make(false);
    await s.onModuleInit();
    expect(await s.setEnabled(true)).toEqual({
      enabled: true,
      running: false,
      deviceName: 'homeMediaCast',
      error: 'EADDRINUSE',
    });
    failStart = undefined;
    await s.setEnabled(false);
    expect(await s.setEnabled(true)).toMatchObject({ running: true });
    expect(s.status().error).toBeUndefined();
  });

  it('quick on/off/on ends up on, with starts and stops in order', async () => {
    const s = make(false);
    await Promise.all([s.setEnabled(true), s.setEnabled(false), s.setEnabled(true)]);
    expect(s.status()).toMatchObject({ enabled: true, running: true });
    expect(
      events.filter((e) => e === 'start').length - events.filter((e) => e === 'stop').length,
    ).toBe(1);
  });

  it('stops the receiver when the backend shuts down', async () => {
    const s = make(true);
    await s.onModuleInit();
    await s.onModuleDestroy();
    expect(events).toEqual(['start', 'stop']);
  });
});
