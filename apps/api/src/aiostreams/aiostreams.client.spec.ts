import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AioStreamsClient,
  SourceAuthError,
  SourceUnavailableError,
  isValidTitleId,
} from './aiostreams.client.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const PASSWORD = 'pa55-SECRET';

describe('AioStreamsClient', () => {
  let server: Server;
  let port: number;
  let seen: { url: string; authorization?: string }[];
  let reply: (res: import('node:http').ServerResponse) => void;

  const client = (over: Partial<ConstructorParameters<typeof AioStreamsClient>[0]> = {}) =>
    new AioStreamsClient({
      url: `http://127.0.0.1:${port}/`,
      uuid: UUID,
      password: PASSWORD,
      ...over,
    });

  beforeEach(async () => {
    seen = [];
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          success: true,
          data: {
            results: [{ url: 'https://h/a.mkv' }, { infoHash: 'x' }],
            errors: [{ title: '[❌] AIOSubtitle', description: 'x' }, {}],
          },
        }),
      );
    };
    server = createServer((req, res) => {
      seen.push({
        url: req.url ?? '',
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      });
      reply(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('searches with Basic uuid:password in the header and nothing secret in the URL', async () => {
    const out = await client().search('series', 'tt7049682:1:4');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/api/v1/search?type=series&id=tt7049682%3A1%3A4');
    const [scheme, token] = (seen[0]?.authorization ?? '').split(' ');
    expect(scheme).toBe('Basic');
    expect(Buffer.from(token ?? '', 'base64').toString()).toBe(`${UUID}:${PASSWORD}`);
    expect(seen[0]?.url).not.toContain(PASSWORD);
    expect(seen[0]?.url).not.toContain(UUID);
    expect(out.results).toHaveLength(2);
    expect(out.errors).toEqual(['[❌] AIOSubtitle', 'Unknown source error']);
  });

  it.each([
    ['movie', 'tt0111161', true],
    ['movie', 'tmdb:603', true],
    ['series', 'tt7049682:1:4', true],
    ['series', 'tmdb:1396:5:16', true],
    ['movie', 'tt0111161:1:4', false],
    ['series', 'tt7049682', false],
    ['movie', '', false],
    ['movie', 'tt1/../../x', false],
    ['movie', 'tt1?x=1', false],
    ['movie', 'tt1\nHost: evil', false],
    ['series', 'tt1:1:4:9', false],
    ['movie', 'ttabc', false],
  ] as const)('%s %j valid=%s', (type, id, ok) => {
    expect(isValidTitleId(type, id)).toBe(ok);
  });

  it('rejects an invalid id without sending a request', async () => {
    await expect(client().search('movie', 'tt1/../x')).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
  });

  it.each([401, 403])('maps %i to SourceAuthError without echoing credentials', async (status) => {
    reply = (res) => void res.writeHead(status).end('nope');
    const e = await client()
      .search('movie', 'tt0111161')
      .catch((x: Error) => x);
    expect(e).toBeInstanceOf(SourceAuthError);
    expect((e as Error).message).not.toMatch(new RegExp(`${PASSWORD}|${UUID}|127\\.0\\.0\\.1`));
  });

  it.each([
    ['a 500', (res: import('node:http').ServerResponse) => void res.writeHead(500).end()],
    ['a 404', (res: import('node:http').ServerResponse) => void res.writeHead(404).end()],
    [
      'invalid JSON',
      (res: import('node:http').ServerResponse) => void res.writeHead(200).end('<html>'),
    ],
    [
      'an unexpected shape',
      (res: import('node:http').ServerResponse) =>
        void res.writeHead(200).end('{"success":true,"data":{"results":5}}'),
    ],
    [
      'success:false',
      (res: import('node:http').ServerResponse) =>
        void res.writeHead(200).end('{"success":false,"error":{"message":"x"},"data":null}'),
    ],
  ])('treats %s as unavailable', async (_n, r) => {
    reply = r;
    await expect(client().search('movie', 'tt0111161')).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });

  it('treats an unreachable host and a timeout as unavailable, with no URL in the message', async () => {
    const dead = await client({ url: 'http://127.0.0.1:1' })
      .search('movie', 'tt0111161')
      .catch((x: Error) => x);
    expect(dead).toBeInstanceOf(SourceUnavailableError);
    expect((dead as Error).message).not.toContain('127.0.0.1');
    reply = () => undefined; // never answers
    const slow = await client({ timeoutMs: 100 })
      .search('movie', 'tt0111161')
      .catch((x: Error) => x);
    expect(slow).toBeInstanceOf(SourceUnavailableError);
  });

  it('stops when the caller aborts', async () => {
    reply = () => undefined;
    const ctl = new AbortController();
    const p = client()
      .search('movie', 'tt0111161', ctl.signal)
      .catch((x: Error) => x);
    ctl.abort();
    expect(await p).toBeInstanceOf(SourceUnavailableError);
  });
});
