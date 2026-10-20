import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';
import { DbService } from './db/db.service.js';
import { KodiService } from './kodi/kodi.service.js';
import { FakeKodiServer } from './kodi/testing/fake-kodi.server.js';

const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('waitFor timed out');
};

describe('HealthController', () => {
  let kodi: FakeKodiServer;
  let service: KodiService;
  let db: DbService;
  let controller: HealthController;

  beforeEach(async () => {
    kodi = new FakeKodiServer();
    await kodi.start();
    kodi.on('JSONRPC.Version', { version: { major: 13, minor: 5, patch: 0 } });
    db = new DbService(':memory:');
    service = new KodiService({
      url: kodi.url,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 50,
      unreachableAfterFailures: 2,
    });
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: KodiService, useValue: service },
        { provide: DbService, useValue: db },
      ],
    }).compile();
    controller = mod.get(HealthController);
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await kodi.stop();
  });

  it('is ok and reports the Kodi API version when connected', async () => {
    await waitFor(() => controller.get().kodi.version !== undefined);
    expect(controller.get()).toEqual({
      status: 'ok',
      kodi: { state: 'connected', version: '13.5.0' },
      db: 'ok',
    });
  });

  it('is degraded and keeps answering when Kodi goes away', async () => {
    await waitFor(() => controller.get().status === 'ok');
    await kodi.stop();
    await waitFor(() => controller.get().kodi.state === 'unreachable');
    expect(controller.get()).toEqual({
      status: 'degraded',
      kodi: { state: 'unreachable' },
      db: 'ok',
    });
  });

  it('is degraded when the database is unusable, even with Kodi connected', async () => {
    await waitFor(() => controller.get().status === 'ok');
    db.onModuleDestroy(); // closes the connection
    expect(controller.get()).toMatchObject({ status: 'degraded', db: 'error' });
    expect(controller.get().kodi.state).toBe('connected');
  });
});
