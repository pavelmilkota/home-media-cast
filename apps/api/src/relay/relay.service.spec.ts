import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UrlGuard } from '../playback/url-guard.js';
import { RelayLinkError, RelayService } from './relay.service.js';

const SECRET = 'SECRET-TOKEN-xyz';
const BODY = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

describe('RelayService', () => {
  let provider: Server;
  let other: Server; // a second origin, for redirects and header scoping
  let relayServer: Server;
  let relay: RelayService;
  let providerPort: number;
  let otherPort: number;
  let relayPort: number;
  let providerLog: { method: string; url: string; range?: string; custom?: string }[];
  let otherLog: { custom?: string }[];
  let streamClosed: boolean;
  let warnings: string[];
  let generation: number;

  const guard = new UrlGuard({ allowHosts: ['127.0.0.1'] });
  const register = (path: string, headers?: Record<string, string>) =>
    relay.register({
      url: `http://127.0.0.1:${providerPort}${path}`,
      ...(headers ? { headers } : {}),
    });
  const get = (id: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>(
      (resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: relayPort, path: `/api/relay/${id}`, method, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );

  beforeEach(async () => {
    providerLog = [];
    otherLog = [];
    streamClosed = false;
    warnings = [];
    generation = 0;
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (m: unknown) => void warnings.push(String(m)),
    );

    provider = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      providerLog.push({
        method: req.method ?? '',
        url: url.pathname,
        ...(req.headers.range ? { range: req.headers.range } : {}),
        ...(req.headers['x-custom'] ? { custom: String(req.headers['x-custom']) } : {}),
      });
      if (url.pathname === '/rotate') {
        generation++; // each resolve issues a new CDN link and kills the previous one
        return void res
          .writeHead(302, { location: `/video?token=${SECRET}&gen=${generation}` })
          .end();
      }
      if (url.pathname === '/video') {
        if (url.searchParams.get('token') !== SECRET) return void res.writeHead(403).end();
        const gen = url.searchParams.get('gen');
        if (gen !== null && Number(gen) !== generation) return void res.writeHead(403).end();
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Math.min(Number(m[2]), BODY.length - 1) : BODY.length - 1;
        res.writeHead(m ? 206 : 200, {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          'content-length': String(end - start + 1),
          ...(m ? { 'content-range': `bytes ${start}-${end}/${BODY.length}` } : {}),
          'x-powered-by': `leak-${SECRET}`,
        });
        return void res.end(req.method === 'HEAD' ? undefined : BODY.subarray(start, end + 1));
      }
      if (url.pathname === '/hop1')
        return void res.writeHead(302, { location: `/video?token=${SECRET}` }).end();
      if (url.pathname === '/cross')
        return void res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/landing` }).end();
      if (url.pathname === '/to-private')
        return void res
          .writeHead(302, { location: `http://localhost:${providerPort}/video?token=${SECRET}` })
          .end();
      if (url.pathname === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
      if (url.pathname === '/dead') return void res.writeHead(404).end();
      if (url.pathname === '/boom') return void res.writeHead(500).end();
      if (url.pathname === '/endless') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.on('close', () => (streamClosed = true));
        const timer = setInterval(() => res.write(Buffer.alloc(1024)), 5);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404).end();
    });
    other = createServer((req, res) => {
      otherLog.push({
        ...(req.headers['x-custom'] ? { custom: String(req.headers['x-custom']) } : {}),
      });
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '3' }).end('abc');
    });
    providerPort = await listen(provider);
    otherPort = await listen(other);
    relay = new RelayService({
      check: (url) => guard.check(url),
      baseUrl: 'http://127.0.0.1:0',
      upstreamTimeoutMs: 1500,
    });
    relayServer = createServer((req, res) => {
      void relay.handle(req, res, (req.url ?? '').split('/').pop() ?? '');
    });
    relayPort = await listen(relayServer);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([close(provider), close(other), close(relayServer)]);
  });

  it('streams the whole file and forwards only the safe headers', async () => {
    const { id } = await register(`/video?token=${SECRET}`);
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.body.equals(BODY)).toBe(true);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('forwards Range and answers 206 with the right slice', async () => {
    const { id } = await register(`/video?token=${SECRET}`);
    const res = await get(id, { Range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.body.equals(BODY.subarray(100, 200))).toBe(true);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${BODY.length}`);
    expect(providerLog.at(-1)?.range).toBe('bytes=100-199');
  });

  it('answers HEAD from metadata fetched once, however many HEADs Kodi sends', async () => {
    const { id } = await register(`/video?token=${SECRET}`);
    for (let i = 0; i < 5; i++) {
      const res = await get(id, {}, 'HEAD');
      expect(res.status).toBe(200);
      expect(res.headers['content-length']).toBe(String(BODY.length));
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.body).toHaveLength(0);
    }
    expect(providerLog).toHaveLength(1);
    expect(providerLog[0]?.range).toBe('bytes=0-0');
  });

  it('follows redirects itself; the client never sees them or the final URL', async () => {
    const { id } = await register('/hop1');
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.body.equals(BODY)).toBe(true);
    expect(res.headers.location).toBeUndefined();
    expect(JSON.stringify(res.headers)).not.toContain(SECRET);
  });

  it('resolves the chain again on every request, so an expired CDN link is replaced', async () => {
    const { id } = await register('/rotate');
    const first = await get(id, { Range: 'bytes=0-9' });
    expect(first.status).toBe(206);
    // Meanwhile the first CDN link has died (a newer one was issued elsewhere).
    generation++;
    const second = await get(id, { Range: 'bytes=10-19' });
    expect(second.status).toBe(206);
    expect(second.body.equals(BODY.subarray(10, 20))).toBe(true);
    expect(providerLog.filter((l) => l.url === '/rotate')).toHaveLength(2);
  });

  it('sends custom headers to the first host only, not to where a redirect leads', async () => {
    const { id } = await register('/cross', { 'x-custom': 'for-first-host' });
    const res = await get(id);
    expect(res.body.toString()).toBe('abc');
    expect(otherLog).toEqual([{}]);
    expect(providerLog[0]?.custom).toBe('for-first-host');
  });

  it('refuses a redirect to an address the URL check blocks', async () => {
    const { id } = await register('/to-private');
    const res = await get(id);
    expect(res.status).toBe(502);
    expect(providerLog.map((l) => l.url)).toEqual(['/to-private']);
  });

  it('gives up on a redirect loop', async () => {
    const { id } = await register('/loop');
    expect((await get(id)).status).toBe(502);
  });

  it('maps a dead or forbidden link to 410 and a server error to 502', async () => {
    expect((await get((await register('/dead')).id)).status).toBe(410);
    expect((await get((await register('/video?token=wrong')).id)).status).toBe(410);
    expect((await get((await register('/boom')).id)).status).toBe(502);
  });

  it('answers 502 when the provider is unreachable', async () => {
    const { id } = await register(`/video?token=${SECRET}`);
    await close(provider);
    expect((await get(id)).status).toBe(502);
  });

  describe('preflight', () => {
    it('passes for a working link, and then HEADs never reach the provider', async () => {
      const { id } = await register(`/video?token=${SECRET}`);
      await relay.preflight(id);
      expect(providerLog).toHaveLength(1);
      for (let i = 0; i < 3; i++) expect((await get(id, {}, 'HEAD')).status).toBe(200);
      expect(providerLog).toHaveLength(1);
    });

    it('reports an expired or refused link, and an unreachable one, without naming a URL', async () => {
      const dead = await relay.preflight((await register('/dead')).id).catch((e: Error) => e);
      expect(dead).toBeInstanceOf(RelayLinkError);
      expect((dead as RelayLinkError).reason).toBe('expired');
      const boom = await relay.preflight((await register('/boom')).id).catch((e: Error) => e);
      expect((boom as RelayLinkError).reason).toBe('unreachable');
      await close(provider);
      const gone = await relay.preflight((await register('/video')).id).catch((e: Error) => e);
      expect((gone as RelayLinkError).reason).toBe('unreachable');
      for (const e of [dead, boom, gone])
        expect((e as Error).message).not.toMatch(/127\.0\.0\.1|http|token/);
    });

    it('reports an unknown id as expired', async () => {
      await expect(relay.preflight('nope')).rejects.toMatchObject({ reason: 'expired' });
    });
  });

  it('answers 404 for an unknown, forgotten or expired id', async () => {
    expect((await get('nope')).status).toBe(404);
    const forgotten = await register('/hop1');
    relay.forget(forgotten.id);
    expect((await get(forgotten.id)).status).toBe(404);
    const short = new RelayService({
      check: (u) => guard.check(u),
      baseUrl: 'http://127.0.0.1:0',
      ttlMs: 20,
    });
    const { id } = await short.register({ url: `http://127.0.0.1:${providerPort}/hop1` });
    await new Promise((r) => setTimeout(r, 40));
    const stub = {
      socket: { remoteAddress: '127.0.0.1' },
      method: 'GET',
      headers: { host: '127.0.0.1:1' },
    };
    const out = { status: 0 };
    await short.handle(
      stub as unknown as IncomingMessage,
      {
        writeHead: (s: number) => void (out.status = s),
        end: () => undefined,
        on: () => undefined,
      } as never,
      id,
    );
    expect(out.status).toBe(404);
  });

  it.each([
    ['a LAN address', { remoteAddress: '192.168.1.50' }, { host: '127.0.0.1:8787' }, 'GET'],
    ['a tailnet address', { remoteAddress: '100.101.102.103' }, { host: '127.0.0.1:8787' }, 'GET'],
    [
      'a rebinding Host header',
      { remoteAddress: '127.0.0.1' },
      { host: 'evil.example:8787' },
      'GET',
    ],
    ['no Host header', { remoteAddress: '127.0.0.1' }, {}, 'GET'],
    ['a POST', { remoteAddress: '127.0.0.1' }, { host: '127.0.0.1:8787' }, 'POST'],
  ])('answers 404 for %s, and never touches the provider', async (_n, socket, headers, method) => {
    const { id } = await register(`/video?token=${SECRET}`);
    const out = { status: 0 };
    await relay.handle(
      { socket, method, headers } as unknown as IncomingMessage,
      {
        writeHead: (s: number) => void (out.status = s),
        end: () => undefined,
        on: () => undefined,
      } as never,
      id,
    );
    expect(out.status).toBe(404);
    expect(providerLog).toHaveLength(0);
  });

  it('refuses to register a URL the check rejects', async () => {
    await expect(relay.register({ url: 'http://192.168.1.1/x' })).rejects.toThrow();
    await expect(relay.register({ url: 'file:///etc/passwd' })).rejects.toThrow();
    await expect(relay.register({ url: 'http://localhost:9090/jsonrpc' })).rejects.toThrow();
  });

  it('stops fetching from the provider when Kodi disconnects', async () => {
    const { id } = await register('/endless');
    await new Promise<void>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port: relayPort, path: `/api/relay/${id}` },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.end();
    });
    for (let i = 0; i < 100 && !streamClosed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(streamClosed).toBe(true);
  });

  it('never puts a provider URL or key into a log line or an error response', async () => {
    const ids = [
      (await register(`/video?token=${SECRET}`)).id,
      (await register('/dead')).id,
      (await register('/boom')).id,
      (await register('/to-private')).id,
    ];
    for (const id of ids) {
      const res = await get(id);
      expect(res.body.toString()).not.toContain(SECRET);
      expect(JSON.stringify(res.headers)).not.toMatch(/token|127\.0\.0\.1:\d+\/video/);
    }
    await close(provider);
    await get((await register('/video')).id).catch(() => undefined);
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings)
      expect(w).not.toMatch(new RegExp(`${SECRET}|127\\.0\\.0\\.1|/video|http`));
  });

  it('keeps at most maxEntries, dropping the oldest', async () => {
    const small = new RelayService({
      check: (u) => guard.check(u),
      baseUrl: 'http://127.0.0.1:0',
      maxEntries: 2,
    });
    const target = { url: `http://127.0.0.1:${providerPort}/hop1` };
    const first = await small.register(target);
    await small.register(target);
    await small.register(target);
    const stub = (id: string) => {
      const out = { status: 0 };
      return small
        .handle(
          {
            socket: { remoteAddress: '127.0.0.1' },
            method: 'HEAD',
            headers: { host: '127.0.0.1:1' },
          } as unknown as IncomingMessage,
          {
            writeHead: (s: number) => void (out.status = s),
            end: () => undefined,
            on: () => undefined,
          } as never,
          id,
        )
        .then(() => out.status);
    };
    expect(await stub(first.id)).toBe(404);
  });

  it('hands out an opaque url that contains no part of the provider URL', async () => {
    const { id, url } = await register(`/video?token=${SECRET}`);
    expect(url).toBe(`http://127.0.0.1:0/api/relay/${id}`);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
