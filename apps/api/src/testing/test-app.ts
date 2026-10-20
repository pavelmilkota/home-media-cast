import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { configureApp } from '../configure-app.js';
import { DbService } from '../db/db.service.js';
import { serveWeb } from '../serve-web.js';
import { KodiService } from '../kodi/kodi.service.js';
import { PlayerStatusService } from '../player/player-status.service.js';
import { FakeKodiServer } from '../kodi/testing/fake-kodi.server.js';
import { JsonFileDataStore } from '../youtube/json-file-data-store.js';
import { KodiRestartService } from '../tv/kodi-restart.service.js';
import { YoutubeService } from '../youtube/youtube.service.js';

export interface TestApp {
  app: INestApplication;
  kodi: FakeKodiServer;
  /** Request log lines, as main.ts would write them. */
  logLines: string[];
  /** The YouTube Cast switch, with a fake receiver: no DIAL server, no UDP 1900 in tests. */
  youtube: YoutubeService;
  /** `http://127.0.0.1:<port>/api` */
  base: string;
  close(): Promise<void>;
  /** JSON request helper; adds the bearer token when given. */
  http(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown },
  ): Promise<{ status: number; body: unknown }>;
}

const waitUntil = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('waitUntil timed out');
};

/** The whole Nest app on a random port, with an in-memory DB and a fake Kodi. */
export async function createTestApp(
  setup: (kodi: FakeKodiServer) => void = () => undefined,
  {
    startKodi = true,
    webDir,
    restart = new KodiRestartService(undefined),
    db = new DbService(':memory:'),
  }: {
    startKodi?: boolean;
    webDir?: string;
    restart?: KodiRestartService;
    /** Pass a file-backed DB to look at state across an "API restart". */
    db?: DbService;
  } = {},
): Promise<TestApp> {
  const kodi = new FakeKodiServer();
  await kodi.start();
  kodi.on('JSONRPC.Version', { version: { major: 13, minor: 5, patch: 0 } });
  setup(kodi);
  const logLines: string[] = [];
  const kodiService = new KodiService({
    url: kodi.url,
    requestTimeoutMs: 300,
    reconnectInitialDelayMs: 20,
    reconnectMaxDelayMs: 50,
    unreachableAfterFailures: 2,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DbService)
    .useValue(db)
    .overrideProvider(KodiService)
    .useValue(kodiService)
    .overrideProvider(PlayerStatusService)
    .useFactory({
      factory: () => new PlayerStatusService(kodiService, { pollIntervalMs: 40, debounceMs: 5 }),
    })
    .overrideProvider(KodiRestartService)
    .useValue(restart)
    .overrideProvider(YoutubeService)
    .useValue(
      new YoutubeService(kodiService, new JsonFileDataStore(), {
        enabled: false,
        dialPort: 0,
        deviceName: 'homeMediaCast',
        receiverFactory: () => ({ start: async () => undefined, stop: async () => undefined }),
      }),
    )
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, (line) => logLines.push(line));
  if (webDir) serveWeb(app, webDir);
  await app.listen(0, '127.0.0.1');
  // Wait for the version too: the backend reads it right after connecting, and a late
  // request would show up as unexpected traffic in tests that count Kodi calls.
  if (startKodi) await waitUntil(() => kodiService.health().version !== undefined);
  const base = `${await app.getUrl()}/api`;
  return {
    app,
    kodi,
    logLines,
    base,
    youtube: app.get(YoutubeService),
    async close() {
      await app.close();
      await kodi.stop();
    },
    async http(method, path, { token, body } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
    },
  };
}

/** Pairs a device through the real endpoints and returns its token. */
export async function pairDevice(t: TestApp, name = 'Test phone'): Promise<string> {
  const started = await t.http('POST', '/pairing/start');
  if (started.status !== 200) throw new Error(`pairing/start -> ${started.status}`);
  const shown = t.kodi.requests.findLast((r) => r.method === 'GUI.ShowNotification');
  const code = /\d{6}/.exec(JSON.stringify(shown?.params))?.[0];
  const done = await t.http('POST', '/pairing/complete', { body: { code, deviceName: name } });
  return (done.body as { token: string }).token;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Reads `count` non-ping events from an SSE endpoint, then closes the stream. */
export async function readSse(
  t: TestApp,
  token: string,
  count: number,
  { timeoutMs = 3000, until }: { timeoutMs?: number; until?: (events: SseEvent[]) => boolean } = {},
): Promise<SseEvent[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const events: SseEvent[] = [];
  try {
    const res = await fetch(`${t.base}/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    if (res.status !== 200) throw new Error(`events -> ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event !== 'ping' && data) events.push({ event, data: JSON.parse(data) });
        if (until ? until(events) : events.length >= count) return events;
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}
