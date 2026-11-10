import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbService } from '../db/db.service.js';
import { devices } from '../db/schema.js';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';
import { GUEST_LIMIT } from './guest.controller.js';
import { GuestController } from './guest.controller.js';

/** What a guest may reach (ADR-0009). Anything not listed here must answer 403. */
const GUEST_ALLOWED = new Set([
  'GET /catalog/search',
  'GET /catalog/discover',
  'GET /catalog/browse',
  'GET /catalog/:type/:id',
  'GET /library',
  'GET /titles/:type/:id/streams',
  'GET /streams/options/:id/audio',
  'GET /playback/history',
  'GET /events',
  'GET /browser-play/config',
  'POST /browser-play/external',
  'DELETE /browser-play/external/:id',
  'POST /browser-play',
  'POST /browser-play/:id/seek',
  'POST /browser-play/:id/started',
  'POST /browser-play/:id/progress',
  'POST /browser-play/:id/error',
  'POST /browser-play/:id/next',
  'POST /browser-play/:id/previous',
  'POST /browser-play/:id/external',
  'POST /browser-play/:id/audio',
  'POST /browser-play/:id/subtitle',
  'DELETE /browser-play/:id',
  'POST /playback/handoff/replay/:id',
]);

/** Routes with no bearer at all: the health check, pairing, guest registration, media, relay. */
const PUBLIC = [/^\/docs/, /^\/health$/, /^\/guest$/, /^\/pairing\//, /^\/relay\//, /^\/media\//];

interface Route {
  method: string;
  path: string;
}

const routesOf = (t: TestApp): Route[] => {
  const instance = t.app.getHttpAdapter().getInstance() as {
    router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  };
  return instance.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route!.methods).map((method) => ({
        method: method.toUpperCase(),
        path: layer.route!.path.replace(/^\/api/, ''),
      })),
    )
    .filter(({ method }) => method !== 'HEAD')
    .filter(({ path }) => !PUBLIC.some((p) => p.test(path)));
};

/** One request; an event stream is closed as soon as its headers arrive. */
const hit = async (
  t: TestApp,
  { method, path }: Route,
  token: string,
): Promise<{ status: number; error?: string }> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(t.base + path.replace(/:\w+/g, 'x'), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      signal: ctl.signal,
    });
    if (path === '/events') {
      ctl.abort();
      return { status: res.status };
    }
    const text = await res.text();
    const error = (text ? (JSON.parse(text) as { error?: string }) : {}).error;
    return { status: res.status, ...(error ? { error } : {}) };
  } finally {
    clearTimeout(timer);
  }
};

const guest = async (t: TestApp, name = 'Guest phone'): Promise<string> => {
  const res = await t.http('POST', '/guest', { body: { deviceName: name } });
  expect(res.status).toBe(200);
  return (res.body as { token: string }).token;
};

describe('guest access (e2e)', () => {
  let t: TestApp;
  const saved = process.env['CINEMETA_URL'];
  // The catalog routes a guest may call would reach the real Cinemeta without this.
  beforeAll(() => {
    process.env['CINEMETA_URL'] = 'http://127.0.0.1:1';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['CINEMETA_URL'];
    else process.env['CINEMETA_URL'] = saved;
  });
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    delete process.env['GUEST_PLAYBACK_ENABLED'];
    await t.close();
  });

  it('registers a guest that is stored as a guest and touches nothing on Kodi', async () => {
    const before = t.kodi.requests.length;
    const token = await guest(t);
    expect(token).toBeTruthy();
    expect(t.kodi.requests.length).toBe(before);
    expect(
      t.app
        .get(DbService)
        .orm.select()
        .from(devices)
        .all()
        .map((d) => d.kind),
    ).toEqual(['guest']);
  });

  it('checks the device name like pairing does', async () => {
    expect((await t.http('POST', '/guest', { body: { deviceName: '  ' } })).status).toBe(400);
    expect((await t.http('POST', '/guest', { body: {} })).status).toBe(400);
  });

  it('answers 429 past the registration limit, and again allows it a minute later', async () => {
    const controller = t.app.get(GuestController);
    let now = 1_000_000;
    controller.now = () => now;
    for (let i = 0; i < GUEST_LIMIT; i++) await guest(t, `g${i}`);
    expect((await t.http('POST', '/guest', { body: { deviceName: 'one more' } })).status).toBe(429);
    now += 60_000;
    expect((await t.http('POST', '/guest', { body: { deviceName: 'one more' } })).status).toBe(200);
  });

  it('refuses every route outside the allowed list, and sends nothing to Kodi', async () => {
    const token = await guest(t);
    const routes = routesOf(t);
    expect(routes.length).toBeGreaterThan(50);
    const denied = routes.filter((r) => !GUEST_ALLOWED.has(`${r.method} ${r.path}`));
    const allowed = routes.filter((r) => GUEST_ALLOWED.has(`${r.method} ${r.path}`));
    // The pinned list names real routes only, so a rename cannot hide a route from this test.
    expect(allowed.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...GUEST_ALLOWED].sort());

    const before = t.kodi.requests.length;
    for (const route of denied) {
      expect(await hit(t, route, token), `${route.method} ${route.path}`).toEqual({
        status: 403,
        error: 'guest_forbidden',
      });
    }
    expect(t.kodi.requests.length).toBe(before);

    for (const route of allowed) {
      const res = await hit(t, route, token);
      expect([401, 403], `${route.method} ${route.path}`).not.toContain(res.status);
    }
  });

  it('lets a paired token reach every route', async () => {
    const token = await pairDevice(t);
    for (const route of routesOf(t)) {
      const res = await hit(t, route, token);
      expect([401, 403], `${route.method} ${route.path}`).not.toContain(res.status);
    }
  });

  it('keeps the guest token out of the TV: it is refused POST /player/stop', async () => {
    const token = await guest(t);
    const before = t.kodi.requests.length;
    const res = await t.http('POST', '/player/stop', { token });
    expect(res).toMatchObject({ status: 403, body: { error: 'guest_forbidden' } });
    expect(t.kodi.requests.length).toBe(before);
  });

  it('pairing with a guest bearer keeps the id, replaces the token and kills the old one', async () => {
    const guestToken = await guest(t);
    const list = await t.http('GET', '/devices', { token: guestToken });
    expect(list.status).toBe(403); // not allowed for guests: read the id from the table instead
    const db = t.app.get(DbService);
    const [row] = db.orm.select().from(devices).all();

    await t.http('POST', '/pairing/start');
    const shown = t.kodi.requests.findLast((r) => r.method === 'GUI.ShowNotification');
    const code = /\d{6}/.exec(JSON.stringify(shown?.params))![0];
    const done = await fetch(`${t.base}/pairing/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({ code, deviceName: 'Paired phone' }),
    });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { deviceId: string; token: string };
    expect(body.deviceId).toBe(row!.id);
    expect(body.token).not.toBe(guestToken);

    expect((await t.http('GET', '/devices', { token: guestToken })).status).toBe(401);
    const after = await t.http('GET', '/devices', { token: body.token });
    expect(after.status).toBe(200);
    expect(db.orm.select().from(devices).all()).toHaveLength(1);
    expect(db.orm.select().from(devices).all()[0]).toMatchObject({
      id: row!.id,
      kind: 'paired',
      name: 'Paired phone',
    });
  });

  it('pairing ignores an invalid bearer and creates a new device', async () => {
    await t.http('POST', '/pairing/start');
    const shown = t.kodi.requests.findLast((r) => r.method === 'GUI.ShowNotification');
    const code = /\d{6}/.exec(JSON.stringify(shown?.params))![0];
    const done = await fetch(`${t.base}/pairing/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nonsense' },
      body: JSON.stringify({ code, deviceName: 'Phone' }),
    });
    expect(done.status).toBe(200);
    expect(t.app.get(DbService).orm.select().from(devices).all()).toMatchObject([
      { kind: 'paired' },
    ]);
  });

  it('a wrong pairing code leaves the guest token working', async () => {
    const guestToken = await guest(t);
    await t.http('POST', '/pairing/start');
    const res = await fetch(`${t.base}/pairing/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({ code: '000000', deviceName: 'Phone' }),
    });
    expect(res.status).toBe(401);
    expect((await t.http('GET', '/library', { token: guestToken })).status).not.toBe(401);
  });
});

describe('guest access switched off (e2e)', () => {
  let t: TestApp;
  afterEach(async () => {
    delete process.env['GUEST_PLAYBACK_ENABLED'];
    await t.close();
  });

  it('refuses registration with guest_disabled, and an existing guest token gets 401', async () => {
    const on = await createTestApp();
    const db = on.app.get(DbService);
    const token = (await on.http('POST', '/guest', { body: { deviceName: 'Phone' } })).body as {
      token: string;
    };
    expect((await on.http('GET', '/library', { token: token.token })).status).not.toBe(401);

    process.env['GUEST_PLAYBACK_ENABLED'] = 'false';
    t = await createTestApp(undefined, { db });
    expect((await t.http('POST', '/guest', { body: { deviceName: 'Phone' } })).body).toMatchObject({
      statusCode: 403,
      error: 'guest_disabled',
    });
    expect((await t.http('GET', '/library', { token: token.token })).status).toBe(401);
    // The first app shares the database; only the second is closed by afterEach.
    await on.kodi.stop();
    await on.app.close();
  });
});
