import { describe, expect, it } from 'vitest';
import { redactLine, redactObject, redactUrl } from './redact.js';

describe('redactUrl', () => {
  it.each([
    [
      'https://cdn.example.com/a.mp4?token=SECRET&x=1',
      'https://cdn.example.com/a.mp4?token=***&x=1',
    ],
    ['https://h/p?apikey=SECRET', 'https://h/p?apikey=***'],
    ['https://h/p?API_KEY=SECRET&Password=SECRET', 'https://h/p?API_KEY=***&Password=***'],
    ['https://user:SECRET@h/p', 'https://h/p'],
    ['/api/events?token=SECRET', '/api/events?token=***'],
    ['/api/health', '/api/health'],
    ['/api/devices/123?x=1#f', '/api/devices/123?x=1#f'],
  ])('%s', (input, expected) => {
    const out = redactUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toContain('SECRET');
  });

  it('drops the query entirely when the URL cannot be parsed', () => {
    expect(redactUrl('http://[bad?token=SECRET')).not.toContain('SECRET');
  });
});

describe('redactObject', () => {
  it('masks sensitive keys at any depth', () => {
    const out = redactObject({
      a: 1,
      authorization: 'Bearer SECRET',
      nested: { password: 'SECRET', list: [{ token: 'SECRET', ok: true }] },
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(out).toMatchObject({ a: 1, nested: { list: [{ ok: true }] } });
  });
});

describe('relay and provider URLs', () => {
  it('masks the relay id in a request log line', () => {
    const out = redactUrl('/api/relay/abcDEF123_-xyz?x=1');
    expect(out).toBe('/api/relay/***?x=1');
  });

  it('masks the browser session id in the media and control paths', () => {
    expect(redactUrl('/api/media/SESSIONid_-123/2/seg14.m4s')).toBe('/api/media/***/2/seg14.m4s');
    expect(redactUrl('http://192.168.1.5:8787/api/media/SESSIONid/1/index.m3u8')).toBe(
      'http://192.168.1.5:8787/api/media/***/1/index.m3u8',
    );
    expect(redactUrl('/api/browser-play/SESSIONid/seek')).toBe('/api/browser-play/***/seek');
    expect(redactUrl('/api/browser-play/SESSIONid')).toBe('/api/browser-play/***');
    expect(redactUrl('/api/browser-play')).toBe('/api/browser-play');
    // An external session: the id in the file path and in the control path.
    expect(redactUrl('/api/media/SESSIONid/file/Movie.2023.mkv')).toBe(
      '/api/media/***/file/Movie.2023.mkv',
    );
    expect(redactUrl('/api/browser-play/external/SESSIONid')).toBe(
      '/api/browser-play/external/***',
    );
    expect(redactUrl('/api/browser-play/external')).toBe('/api/browser-play/external');
    expect(redactLine('DELETE /api/browser-play/external/SESSIONid 204')).toBe(
      'DELETE /api/browser-play/external/*** 204',
    );
    expect(redactLine('POST /api/browser-play/external 201')).toBe(
      'POST /api/browser-play/external 201',
    );
  });

  it('masks the session id in a free-text line too', () => {
    expect(redactLine('GET /api/media/SESSIONid/1/seg0.m4s 200')).toBe(
      'GET /api/media/***/1/seg0.m4s 200',
    );
  });

  it('logs a provider URL as its host only', async () => {
    const { redactProviderUrl } = await import('./redact.js');
    for (const url of [
      'https://torrentio.strem.fun/resolve/torbox/SECRET/hash/null/0/x.mkv',
      'https://h.tb-cdn.st/dl/abc?token=SECRET',
      'https://aio.ts.net:8443/api/v1/proxy/e.SECRET.e.SECRET/x.mkv',
    ]) {
      expect(redactProviderUrl(url)).not.toContain('SECRET');
    }
    expect(redactProviderUrl('https://aio.ts.net:8443/api/v1/proxy/x')).toBe(
      'https://aio.ts.net:8443',
    );
    expect(redactProviderUrl('not a url')).toBe('(unparseable url)');
  });
});

describe('redactLine', () => {
  it.each([
    [
      'WARNING <general>: CFileCache::Process - <http://127.0.0.1:8787/api/relay/3f9a1c2e-77/movie.mkv> read failed',
      'WARNING <general>: CFileCache::Process - <http://127.0.0.1:8787/api/relay/***/movie.mkv> read failed',
    ],
    [
      'GET https://cdn.example.com/a.mp4?token=SECRET&x=1 200',
      'GET https://cdn.example.com/a.mp4?token=***&x=1 200',
    ],
    ['https://h/p?apikey=SECRET&API_KEY=SECRET2', 'https://h/p?apikey=***&API_KEY=***'],
    ['fetching https://user:SECRET@host.example/p', 'fetching https://host.example/p'],
    ['Authorization: Bearer abc.DEF-123', 'Authorization: ***'],
    ['sent header Bearer abc.DEF-123 to addon', 'sent header Bearer *** to addon'],
    ['{"password": "SECRET", "name": "x"}', '{"password": "***", "name": "x"}'],
    ['refresh_token=SECRET done', 'refresh_token=*** done'],
    ['uuid: SECRET', 'uuid: ***'],
  ])('%s', (input, expected) => {
    const out = redactLine(input);
    expect(out).toBe(expected);
    expect(out).not.toContain('SECRET');
  });

  it.each([
    'INFO <general>: Loading skin Estuary',
    '[Nest] 1  - LOG [RelayService] Relay request failed: Upstream unreachable',
    'GET /api/health 200 3ms',
    'monkey=banana',
    'http://127.0.0.1:8787',
    '',
  ])('leaves %j unchanged', (line) => {
    expect(redactLine(line)).toBe(line);
  });

  it('does not throw on odd input', () => {
    expect(() => redactLine('\u0000'.repeat(10_000) + 'token=')).not.toThrow();
  });
});
