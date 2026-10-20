import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KodiClient } from './kodi.client.js';
import { KodiRpcError, KodiTimeoutError, KodiUnavailableError } from './kodi.errors.js';
import type { KodiConnectionState, KodiNotification } from './kodi.types.js';
import { FakeKodiServer } from './testing/fake-kodi.server.js';

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('KodiClient', () => {
  let kodi: FakeKodiServer;
  let client: KodiClient;
  const fast = {
    requestTimeoutMs: 200,
    reconnectInitialDelayMs: 20,
    reconnectMaxDelayMs: 100,
    unreachableAfterFailures: 2,
  };

  beforeEach(async () => {
    kodi = new FakeKodiServer();
    await kodi.start();
    client = new KodiClient({ url: kodi.url, ...fast });
  });

  afterEach(async () => {
    client.stop();
    await kodi.stop();
  });

  it('connects and returns a result', async () => {
    kodi.on('JSONRPC.Version', { version: { major: 13, minor: 5, patch: 0 } });
    client.start();
    await waitFor(() => client.state === 'connected');
    await expect(client.request('JSONRPC.Version')).resolves.toEqual({
      version: { major: 13, minor: 5, patch: 0 },
    });
  });

  it('matches concurrent responses to their requests by id', async () => {
    kodi.onCall('Application.GetProperties', (p) => ({ echo: p['properties'] }));
    client.start();
    await waitFor(() => client.state === 'connected');
    const [a, b] = await Promise.all([
      client.request('Application.GetProperties', { properties: ['volume'] }),
      client.request('Application.GetProperties', { properties: ['muted'] }),
    ]);
    expect(a).toEqual({ echo: ['volume'] });
    expect(b).toEqual({ echo: ['muted'] });
  });

  it('rejects immediately when not connected', async () => {
    await expect(client.request('JSONRPC.Version')).rejects.toBeInstanceOf(KodiUnavailableError);
  });

  it('maps a JSON-RPC error to KodiRpcError', async () => {
    client.start();
    await waitFor(() => client.state === 'connected');
    const err = await client.request('No.SuchMethod').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KodiRpcError);
    expect((err as KodiRpcError).code).toBe(-32601);
  });

  it('rejects invalid params the way Kodi does', async () => {
    client.start();
    await waitFor(() => client.state === 'connected');
    const err = await client.request('Player.Stop', {}).catch((e: unknown) => e);
    expect((err as KodiRpcError).code).toBe(-32602);
  });

  it('times out when Kodi stops answering, and ignores the late answer', async () => {
    client.start();
    await waitFor(() => client.state === 'connected');
    kodi.setSilent(true);
    await expect(client.request('JSONRPC.Version')).rejects.toBeInstanceOf(KodiTimeoutError);
    kodi.setSilent(false);
    await expect(client.request('JSONRPC.Version')).resolves.toBeDefined();
  });

  it('emits notifications', async () => {
    const seen: KodiNotification[] = [];
    client.on('notification', (n) => seen.push(n));
    client.start();
    await waitFor(() => client.state === 'connected');
    kodi.notify('Application.OnVolumeChanged', { data: { volume: 30, muted: false } });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({
      method: 'Application.OnVolumeChanged',
      params: { data: { volume: 30, muted: false } },
    });
  });

  it('rejects in-flight requests when the connection drops', async () => {
    client.start();
    await waitFor(() => client.state === 'connected');
    kodi.setSilent(true);
    const inflight = client.request('JSONRPC.Version');
    await waitFor(() => kodi.requests.length === 1);
    kodi.dropConnections();
    await expect(inflight).rejects.toBeInstanceOf(KodiUnavailableError);
  });

  it('goes reconnecting, then connected again after a drop', async () => {
    const states: KodiConnectionState[] = [];
    client.on('state', (s) => states.push(s));
    client.start();
    await waitFor(() => client.state === 'connected');
    kodi.dropConnections();
    await waitFor(() => client.state === 'connected' && states.length >= 4);
    expect(states).toEqual(['reconnecting', 'connected', 'reconnecting', 'connected']);
    await expect(client.request('JSONRPC.Version')).resolves.toBeDefined();
  });

  it('becomes unreachable when Kodi is down, and recovers when it returns', async () => {
    const port = kodi.port;
    await kodi.stop();
    client.start();
    await waitFor(() => client.state === 'unreachable');
    kodi = new FakeKodiServer();
    await kodi.start(port);
    await waitFor(() => client.state === 'connected');
  });

  it('stop() prevents further reconnects', async () => {
    client.start();
    await waitFor(() => client.state === 'connected');
    client.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(kodi.connectionCount).toBe(0);
    expect(client.state).toBe('unreachable');
  });
});
