import { describe, expect, it } from 'vitest';
import { detectPlatform, externalPlayerLink, vlcPlaylist } from './external-player.js';

const URL_ = 'http://192.168.1.5:8787/api/media/SESS_id-1/file/Movie_2023.mkv';
const info = { title: 'The Movie (1994)', positionMs: 754_000 };

describe('externalPlayerLink', () => {
  it('Android: an intent for VLC with the title and the position in milliseconds', () => {
    const out = externalPlayerLink('android', URL_, info);
    expect(out).toEqual({
      kind: 'link',
      href:
        'intent://192.168.1.5:8787/api/media/SESS_id-1/file/Movie_2023.mkv#Intent;scheme=http;' +
        'package=org.videolan.vlc;type=video/*;S.title=The%20Movie%20(1994);l.position=754000;end',
    });
  });

  it('Android: leaves the position out at the start, and cannot be broken out of by the title', () => {
    const start = externalPlayerLink('android', URL_, { title: 'x', positionMs: 0 });
    expect(start).toMatchObject({ kind: 'link' });
    expect((start as { href: string }).href).not.toContain('position');
    const evil = externalPlayerLink('android', URL_, { title: 'a;end;S.browser_fallback_url=//x' });
    const href = (evil as { href: string }).href;
    expect(href.match(/;end$/)).not.toBeNull();
    expect(href.split(';').filter((p) => p.startsWith('S.'))).toHaveLength(1);
  });

  it('iOS: the VLC x-callback link with the URL encoded', () => {
    expect(externalPlayerLink('ios', URL_, info)).toEqual({
      kind: 'link',
      href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(URL_)}`,
    });
  });

  it('Mac: an IINA weblink with the start in seconds, the address to copy and a VLC playlist', () => {
    expect(externalPlayerLink('mac', URL_, info)).toEqual({
      kind: 'link',
      href: `iina://weblink?url=${encodeURIComponent(URL_)}&mpv_start=754`,
      alsoCopy: URL_,
      hint: 'mac',
      playlist: vlcPlaylist(URL_, 'The Movie (1994)', 754),
    });
    expect(
      (externalPlayerLink('mac', URL_, { title: 't' }) as { href: string }).href,
    ).not.toContain('mpv_start');
  });

  it('Linux: the hmc-vlc link for the helper, with the address to copy as a way out', () => {
    expect(externalPlayerLink('linux', URL_, info)).toEqual({
      kind: 'link',
      href: `hmc-vlc://open?url=${encodeURIComponent(URL_)}&start=754`,
      alsoCopy: URL_,
      hint: 'linux',
      playlist: vlcPlaylist(URL_, 'The Movie (1994)', 754),
    });
  });

  it('the VLC playlist carries the address, the title and the start time, escaped', () => {
    const { filename, href } = vlcPlaylist(
      'http://h/api/media/I/file/a&b.mkv',
      'Tom & "Jerry"',
      90,
    );
    const xml = decodeURIComponent(href.replace('data:application/xspf+xml;charset=utf-8,', ''));
    expect(filename).toBe('video.xspf');
    expect(xml).toContain('<location>http://h/api/media/I/file/a&#38;b.mkv</location>');
    expect(xml).toContain('<title>Tom &#38; &#34;Jerry&#34;</title>');
    expect(xml).toContain('<vlc:option>start-time=90</vlc:option>');
    expect(vlcPlaylist('http://h/x', 't', 0).href).not.toContain('start-time');
  });

  it('other desktops: the address to copy, never a download', () => {
    expect(externalPlayerLink('other', URL_, info)).toEqual({ kind: 'copy', url: URL_ });
  });

  it('never builds a file to download', () => {
    for (const platform of ['other', 'linux', 'android', 'ios', 'mac'] as const) {
      expect(['link', 'copy']).toContain(externalPlayerLink(platform, URL_, info).kind);
    }
  });

  it('percent-encodes spaces and brackets in the address', () => {
    const spaced = 'http://192.168.1.5:8787/api/media/ID/file/My Movie [1080p].mkv';
    expect(externalPlayerLink('other', spaced, info)).toEqual({
      kind: 'copy',
      url: 'http://192.168.1.5:8787/api/media/ID/file/My%20Movie%20[1080p].mkv',
    });
    const ios = externalPlayerLink('ios', spaced, info) as { href: string };
    expect(ios.href).toContain('My%2520Movie');
  });
});

describe('detectPlatform', () => {
  it.each([
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120', 5, 'android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari', 5, 'ios'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 5, 'ios'], // iPadOS
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 0, 'mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', 0, 'other'],
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox/120', 0, 'linux'], // Linux Mint
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/120', 0, 'other'],
  ] as const)('%s', (ua, touch, expected) => {
    expect(detectPlatform(ua, touch)).toBe(expected);
  });
});
