import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { RelayService } from './relay.service.js';

const SECRET = 'E2E-SECRET-TOKEN';

describe('/api/relay (e2e)', () => {
  let t: TestApp;
  let provider: Server;
  let providerPort: number;
  let previous: string | undefined;

  beforeEach(async () => {
    provider = createServer((req, res) => {
      const ok = new URL(req.url ?? '/', 'http://x').searchParams.get('token') === SECRET;
      res.writeHead(ok ? 200 : 403, { 'content-type': 'video/mp4' }).end(ok ? 'video-bytes' : '');
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
    providerPort = (provider.address() as AddressInfo).port;
    previous = process.env['PLAYBACK_ALLOW_HOSTS'];
    process.env['PLAYBACK_ALLOW_HOSTS'] = '127.0.0.1';
    t = await createTestApp();
  });
  afterEach(async () => {
    process.env['PLAYBACK_ALLOW_HOSTS'] = previous ?? '';
    if (previous === undefined) delete process.env['PLAYBACK_ALLOW_HOSTS'];
    await t.close();
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
  });

  it('serves the provider stream to a loopback client without a bearer token', async () => {
    const relay = t.app.get(RelayService);
    const { id } = await relay.register({
      url: `http://127.0.0.1:${providerPort}/v?token=${SECRET}`,
    });
    const res = await fetch(`${t.base}/relay/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('video-bytes');
  });

  it('does not accept a provider URL the SSRF rules block (wiring of the URL check)', async () => {
    process.env['PLAYBACK_ALLOW_HOSTS'] = '';
    const strict = await createTestApp();
    try {
      await expect(
        strict.app.get(RelayService).register({ url: `http://127.0.0.1:${providerPort}/v` }),
      ).rejects.toThrow();
    } finally {
      await strict.close();
    }
  });

  it('keeps the relay id out of the request log', async () => {
    const { id } = await t.app
      .get(RelayService)
      .register({ url: `http://127.0.0.1:${providerPort}/v?token=${SECRET}` });
    await fetch(`${t.base}/relay/${id}`);
    const line = t.logLines.find((l) => l.includes('/api/relay/'));
    expect(line).toContain('/api/relay/***');
    expect(t.logLines.join('\n')).not.toContain(id);
    expect(t.logLines.join('\n')).not.toContain(SECRET);
  });

  it('answers 404 for an unknown id, and does not appear in the OpenAPI document', async () => {
    expect((await fetch(`${t.base}/relay/unknown`)).status).toBe(404);
    const doc = (await (await fetch(`${t.base}/docs-json`)).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths).some((p) => p.includes('relay'))).toBe(false);
  });
});
