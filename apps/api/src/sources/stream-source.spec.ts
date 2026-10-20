import { describe, expect, it } from 'vitest';
import { classifyResult, releaseKey, releaseMatch, toOption } from './stream-source.js';

const HASH = 'dace3fb370fc9567447fd9b1f19fee787b4d3f17';
const SECRET = 'SECRET-KEY-123';

// The shapes recorded from the owner's AIOStreams on 2026-10-19 (values replaced by markers).
const proxied = {
  url: `https://aio.example.ts.net:8443/api/v1/proxy/e.${SECRET}.e.${SECRET}/Movie.2024.1080p.mkv`,
  infoHash: HASH,
  filename: 'Movie.2024.1080p.mkv',
  service: 'realdebrid',
  cached: true,
  proxied: true,
  size: 3_543_000_000,
};
const comet = {
  url: `https://comet.example/${SECRET}/playback/${HASH}/n/0/x/y?torrent_name=a&name=b&media_id=tt1&media_type=movie`,
  infoHash: HASH,
  filename: 'Show.S01E04.720p.mkv',
  service: 'TorBox',
  cached: true,
};
const torrentio = {
  url: `https://torrentio.strem.fun/resolve/torbox/${SECRET}/${HASH}/null/0/Show.mkv`,
  infoHash: HASH,
  cached: false,
  service: 'torbox',
};

describe('classifyResult', () => {
  it.each([
    ['AIOStreams proxy URL', proxied],
    ['Comet redirect URL', comet],
    ['Torrentio resolve URL', torrentio],
  ])('%s is a direct_url, even though it also has an info hash', (_name, raw) => {
    const c = classifyResult(raw);
    expect(c.source).toMatchObject({ kind: 'direct_url', url: raw.url });
  });

  it('reads display data and normalises the service name', () => {
    expect(classifyResult(comet)).toMatchObject({
      title: 'Show.S01E04.720p.mkv',
      service: 'torbox',
      cached: true,
    });
    expect(classifyResult(proxied).sizeBytes).toBe(3_543_000_000);
    expect(classifyResult(torrentio).cached).toBe(false);
  });

  it('reads languages and resolution from the result or from parsedFile', () => {
    expect(
      classifyResult({
        url: 'https://h/x',
        languages: ['Ukrainian', 'English', 'English', ' ', 7],
        resolution: '2160p',
      }),
    ).toMatchObject({ languages: ['Ukrainian', 'English'], resolution: '2160p' });
    expect(
      classifyResult({
        url: 'https://h/x',
        parsedFile: { languages: ['Polish'], resolution: '720p' },
      }),
    ).toMatchObject({ languages: ['Polish'], resolution: '720p' });
    const none = classifyResult({ url: 'https://h/x', languages: 'English', resolution: 5 });
    expect(none).not.toHaveProperty('languages');
    expect(none).not.toHaveProperty('resolution');
  });

  it('takes the resolution from the file name when the result has none', () => {
    const of = (filename: string) => classifyResult({ url: 'https://h/x', filename }).resolution;
    expect(of('Movie.2160p.HDR.mkv')).toBe('2160p');
    expect(of('Show S01E02 1080p WEB-DL.mkv')).toBe('1080p');
    expect(of('Old.Film.720P.mkv')).toBe('720p');
    expect(of('Movie.4K.HDR.mkv')).toBe('2160p');
    expect(of('Movie.UHD.mkv')).toBe('2160p');
    expect(of('Movie.1080i.mkv')).toBe('1080p');
    expect(of('Movie.x264.mkv')).toBeUndefined();
    expect(of('Movie.21600p.mkv')).toBeUndefined();
    // what the result says wins over the name
    expect(
      classifyResult({ url: 'https://h/x', filename: 'a.720p.mkv', resolution: '1080p' })
        .resolution,
    ).toBe('1080p');
  });

  it('keeps request headers that are strings, and drops the rest', () => {
    const c = classifyResult({
      url: 'https://h/a.mp4',
      requestHeaders: { Referer: 'https://x', Bad: 5 },
    });
    expect(c.source).toEqual({
      kind: 'direct_url',
      url: 'https://h/a.mp4',
      headers: { Referer: 'https://x' },
    });
  });

  it.each([
    [{ ytId: 'jNQXAC9IVRw' }, { kind: 'youtube', videoId: 'jNQXAC9IVRw' }],
    [{ ytId: 'bad id' }, { kind: 'unsupported', reason: 'Invalid YouTube id' }],
    [
      { ytId: 'jNQXAC9IVRw', url: 'https://h/a.mp4' },
      { kind: 'youtube', videoId: 'jNQXAC9IVRw' },
    ],
    [
      { externalUrl: 'https://example.com/page' },
      { kind: 'external_url', url: 'https://example.com/page' },
    ],
    [{ infoHash: HASH.toUpperCase() }, { kind: 'torrent', infoHash: HASH }],
    [
      { infoHash: HASH, fileIdx: 3 },
      { kind: 'torrent', infoHash: HASH, fileIdx: 3 },
    ],
    [{ infoHash: 'nothex' }, { kind: 'unsupported', reason: 'Invalid info hash' }],
    [
      { nzbUrl: 'https://h/x.nzb' },
      { kind: 'unsupported', reason: 'Unsupported source type (nzbUrl)' },
    ],
    [
      { zipUrls: ['https://h/a.zip'] },
      { kind: 'unsupported', reason: 'Unsupported source type (zipUrls)' },
    ],
    [
      { rarUrls: [], infoHash: HASH },
      { kind: 'torrent', infoHash: HASH },
    ],
    [
      { url: 'rtmp://h/live', infoHash: HASH },
      { kind: 'unsupported', reason: 'Unsupported link type (rtmp)' },
    ],
    [{ url: 'ftp://h/a.mp4' }, { kind: 'unsupported', reason: 'Unsupported link type (ftp)' }],
    [
      { url: 'file:///etc/passwd' },
      { kind: 'unsupported', reason: 'Unsupported link type (file)' },
    ],
    [
      { url: 'plugin://plugin.video.youtube/?x=1' },
      { kind: 'unsupported', reason: 'Unsupported link type (plugin)' },
    ],
    [{ url: 'not a url' }, { kind: 'unsupported', reason: 'Not a valid URL' }],
    [{}, { kind: 'unsupported', reason: 'Nothing to play in this result' }],
  ])('%j -> %j', (raw, expected) => {
    expect(classifyResult(raw).source).toEqual(expected);
  });

  it.each([null, undefined, 5, 'text', [], true])('never throws on %j', (input) => {
    expect(classifyResult(input).source.kind).toBe('unsupported');
  });

  it('treats a non-boolean cached as unknown', () => {
    expect(classifyResult({ url: 'https://h/a', cached: 'yes' }).cached).toBeNull();
  });

  it('does not take a title with a query string from the provider', () => {
    expect(
      classifyResult({ url: 'https://h/a', filename: `https://cdn/x.mkv?token=${SECRET}` }).title,
    ).toBe('x.mkv');
  });
});

describe('toOption', () => {
  it.each([proxied, comet, torrentio])('never carries the URL, hash or any secret', (raw) => {
    const option = toOption('id1', classifyResult(raw));
    const json = JSON.stringify(option);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(HASH);
    expect(json).not.toContain('http');
    expect(option).toMatchObject({ id: 'id1', kind: 'direct_url', playable: true });
  });

  it('describes what it cannot play', () => {
    expect(toOption('a', classifyResult({ nzbUrl: 'https://h/x.nzb' }))).toMatchObject({
      kind: 'unsupported',
      playable: false,
      reason: 'Unsupported source type (nzbUrl)',
    });
    expect(toOption('b', classifyResult({ externalUrl: 'https://h/p' }))).toMatchObject({
      kind: 'external_url',
      playable: false,
    });
    const torrent = toOption('c', classifyResult({ infoHash: HASH, cached: true }));
    expect(torrent).toMatchObject({ kind: 'torrent', playable: false });
    expect(JSON.stringify(torrent)).not.toContain(HASH);
  });
});

describe('releaseKey', () => {
  const base = { url: 'https://h/a', bingeGroup: 'g', parsedFile: { resolution: '1080p' } };
  const key = (extra: object) => releaseKey(classifyResult({ ...base, ...extra }));

  it('tells variants of one group apart by resolution and languages', () => {
    const en = key({ languages: ['English'] });
    expect(en).toBe(key({ languages: ['English'] }));
    expect(en).not.toBe(key({ languages: ['English', 'French'] }));
    expect(en).not.toBe(key({ languages: ['English'], parsedFile: { resolution: '720p' } }));
  });

  it('ignores the order of the languages and is undefined without a group', () => {
    expect(key({ languages: ['a', 'b'] })).toBe(key({ languages: ['b', 'a'] }));
    expect(releaseKey(classifyResult({ url: 'https://h/a' }))).toBeUndefined();
  });
});

describe('releaseMatch', () => {
  const pick = (extra: object) =>
    classifyResult({ url: 'https://h/a', bingeGroup: 'g', languages: ['English'], ...extra });
  const key = releaseKey(pick({ infoHash: HASH }))!;

  it('ranks the same torrent above a look-alike and rejects other variants', () => {
    expect(releaseMatch(key, pick({ infoHash: HASH, bingeGroup: 'other' }))).toBe(2);
    expect(releaseMatch(key, pick({ infoHash: 'a'.repeat(40) }))).toBe(1);
    expect(releaseMatch(key, pick({ infoHash: 'a'.repeat(40), languages: ['French'] }))).toBe(0);
  });
});
