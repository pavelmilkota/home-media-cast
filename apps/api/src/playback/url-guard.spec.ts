import { describe, expect, it } from 'vitest';
import { UrlGuard, UrlRejectedError, type Resolver } from './url-guard.js';

const noDns: Resolver = () => Promise.reject(new Error('NXDOMAIN'));
const guard = (opts: ConstructorParameters<typeof UrlGuard>[0] = {}) =>
  new UrlGuard({ resolver: noDns, ...opts });

describe('UrlGuard', () => {
  describe('rejects (acceptance criterion #8)', () => {
    it.each([
      ['Kodi JSON-RPC', 'http://127.0.0.1:9090'],
      ['server on the LAN', 'http://192.168.1.10:3000'],
      ['tailnet address', 'http://100.101.102.103/'],
      ['file scheme', 'file:///etc/passwd'],
    ])('%s: %s', async (_name, url) => {
      await expect(guard().check(url)).rejects.toBeInstanceOf(UrlRejectedError);
    });
  });

  describe('rejects other local and special targets', () => {
    it.each([
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/',
      'http://100.127.255.255/',
      'http://224.0.0.1/',
      'http://255.255.255.255/',
      'http://[::1]/',
      'http://[::]/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:c0a8:4468]/',
      'http://[2001:db8::1]/',
      'http://[2002:7f00:1::]/',
      'http://2130706433/', // 127.0.0.1 as one decimal number
      'http://0x7f.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
    ])('%s', async (url) => {
      await expect(guard().check(url)).rejects.toBeInstanceOf(UrlRejectedError);
    });

    it.each([
      'ftp://example.com/a.mp4',
      'plugin://plugin.video.youtube/?video_id=x',
      'smb://host/share/a.mp4',
      'special://home/a.mp4',
      'javascript:alert(1)',
      'http://user:pass@93.184.216.34/a.mp4',
      'http://93.184.216.34/a.mp4|User-Agent=x',
      'not a url',
      '',
      `http://93.184.216.34/${'a'.repeat(4100)}`,
    ])('%s', async (url) => {
      await expect(guard().check(url)).rejects.toBeInstanceOf(UrlRejectedError);
    });
  });

  describe('host names', () => {
    it('rejects a name that resolves to a private address', async () => {
      const g = guard({ resolver: async () => ['192.168.1.5'] });
      await expect(g.check('http://nas.example.com/a.mp4')).rejects.toBeInstanceOf(
        UrlRejectedError,
      );
    });

    it('rejects if any one of several addresses is private', async () => {
      const g = guard({ resolver: async () => ['93.184.216.34', '127.0.0.1'] });
      await expect(g.check('http://mixed.example.com/')).rejects.toBeInstanceOf(UrlRejectedError);
    });

    it('rejects a name that does not resolve', async () => {
      await expect(guard().check('http://nope.invalid/')).rejects.toBeInstanceOf(UrlRejectedError);
    });

    it('rejects localhost via the system resolver', async () => {
      await expect(new UrlGuard().check('http://localhost:9090/')).rejects.toBeInstanceOf(
        UrlRejectedError,
      );
    });

    it('accepts a name that resolves to a public address', async () => {
      const g = guard({ resolver: async () => ['93.184.216.34', '2606:2800:220:1::1'] });
      await expect(g.check('https://media.example.com/a.mp4?x=1')).resolves.toBe(
        'https://media.example.com/a.mp4?x=1',
      );
    });
  });

  describe('accepts public addresses', () => {
    it.each([
      'http://93.184.216.34/a.mp4',
      'https://8.8.8.8/',
      'http://[2606:2800:220:1::1]/a.mp4',
    ])('%s', async (url) => {
      await expect(guard().check(url)).resolves.toBeTypeOf('string');
    });
  });

  describe('explicit allowlist', () => {
    it('lets a listed private IP through', async () => {
      const g = guard({ allowHosts: ['192.168.1.10'] });
      await expect(g.check('http://192.168.1.10:8096/video.mkv')).resolves.toBeTypeOf('string');
    });

    it('lets a listed name through without DNS, case-insensitively', async () => {
      const g = guard({ allowHosts: ['Mediaserver.lan'] });
      await expect(g.check('http://mediaserver.lan/a.mp4')).resolves.toBeTypeOf('string');
    });

    it('still blocks other private hosts and bad schemes', async () => {
      const g = guard({ allowHosts: ['192.168.1.10'] });
      await expect(g.check('http://192.168.1.11/')).rejects.toBeInstanceOf(UrlRejectedError);
      await expect(g.check('file://192.168.1.10/etc/passwd')).rejects.toBeInstanceOf(
        UrlRejectedError,
      );
    });
  });
});
