import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class UrlRejectedError extends Error {
  override readonly name = 'UrlRejectedError';
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Everything a user-pasted link must never reach: this machine, the LAN, the tailnet. */
// Two lists on purpose: BlockList also tests an IPv4 address against IPv6 rules as an
// IPv4-mapped address, and `::/3` below would then reject every public IPv4 address.
const DENIED_V4 = new BlockList();
const DENIED_V6 = new BlockList();
const v4 = (net: string, prefix: number) => DENIED_V4.addSubnet(net, prefix, 'ipv4');
const v6 = (net: string, prefix: number) => DENIED_V6.addSubnet(net, prefix, 'ipv6');
v4('0.0.0.0', 8); // "this network"
v4('10.0.0.0', 8); // RFC1918
v4('100.64.0.0', 10); // CGNAT, includes Tailscale 100.x
v4('127.0.0.0', 8); // loopback
v4('169.254.0.0', 16); // link-local, cloud metadata
v4('172.16.0.0', 12); // RFC1918
v4('192.0.0.0', 24); // IETF protocol assignments
v4('192.0.2.0', 24); // documentation
v4('192.168.0.0', 16); // RFC1918
v4('198.18.0.0', 15); // benchmarking
v4('198.51.100.0', 24); // documentation
v4('203.0.113.0', 24); // documentation
v4('224.0.0.0', 4); // multicast
v4('240.0.0.0', 4); // reserved + broadcast
// IPv6: only global unicast 2000::/3 may pass, minus a few special blocks inside it.
v6('::', 3); // ::, ::1, IPv4-mapped (::ffff:0:0/96), IPv4-compatible
v6('4000::', 2);
v6('8000::', 1); // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast
v6('2001::', 32); // Teredo
v6('2001:db8::', 32); // documentation
v6('2002::', 16); // 6to4

export interface UrlGuardOptions {
  /** Hostnames or IP literals that may resolve to private addresses (e.g. a self-hosted AIOStreams on the LAN). */
  allowHosts?: string[];
  resolver?: Resolver;
}

/**
 * SSRF check for user-pasted links (ADR-0007). The backend never downloads the URL itself;
 * Kodi runs on this machine and would, so the same rules apply. ⚠️ DNS rebinding and HTTP
 * redirects are not closed: Kodi resolves and follows redirects on its own.
 */
export class UrlGuard {
  private readonly allowHosts: Set<string>;
  private readonly resolver: Resolver;

  constructor({ allowHosts = [], resolver = systemResolver }: UrlGuardOptions = {}) {
    this.allowHosts = new Set(allowHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
    this.resolver = resolver;
  }

  /** Returns the normalised URL, or throws UrlRejectedError. */
  async check(raw: string): Promise<string> {
    if (raw.length > 4096) throw new UrlRejectedError('URL is too long');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UrlRejectedError('Not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UrlRejectedError('Only http and https links can be played');
    }
    if (url.username || url.password) {
      throw new UrlRejectedError('Links with embedded credentials are not allowed');
    }
    if (raw.includes('|')) throw new UrlRejectedError('Link must not contain "|"');

    // The WHATWG parser already turns 2130706433, 0x7f.1 and 0177.0.0.1 into 127.0.0.1.
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (this.allowHosts.has(host)) return url.href;

    const addresses = isIP(host) ? [host] : await this.resolve(host);
    for (const address of addresses) {
      if (this.isDenied(address)) {
        throw new UrlRejectedError('That address is not allowed (local or private network)');
      }
    }
    return url.href;
  }

  private async resolve(host: string): Promise<string[]> {
    let addresses: string[];
    try {
      addresses = await this.resolver(host);
    } catch {
      throw new UrlRejectedError('The host name could not be resolved');
    }
    if (addresses.length === 0) throw new UrlRejectedError('The host name could not be resolved');
    return addresses;
  }

  private isDenied(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return true; // fail closed on anything unparseable
    return family === 4 ? DENIED_V4.check(address, 'ipv4') : DENIED_V6.check(address, 'ipv6');
  }
}
