import { describe, expect, it } from 'vitest';
import { redactObject, redactUrl } from './redact.js';

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
