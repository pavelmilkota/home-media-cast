/**
 * Handing a source to an external player (VLC and the like) with a link a web page can open. These
 * links come from old or secondary sources and have not been tried on real devices (spike.md), so
 * where there is none the address is copied for the person to paste into the player. ⚠️ unverified.
 * Linux needs a one-time helper on the machine (`scripts/linux`).
 */
export type Platform = 'android' | 'ios' | 'mac' | 'linux' | 'other';

/** A file the person can choose to download and open: VLC starts the stream from it. */
export interface Playlist {
  filename: string;
  /** A `data:` address, so the link works as it is. */
  href: string;
}

export type ExternalLaunch =
  /**
   * `alsoCopy`: where the link needs an app or helper that may not be installed, the address is
   * copied too, and `hint` says which explanation to show.
   */
  | { kind: 'link'; href: string; alsoCopy?: string; hint?: 'linux' | 'mac'; playlist?: Playlist }
  /** No way to open a player from this browser: the address is copied. Nothing is downloaded. */
  | { kind: 'copy'; url: string };

export interface LaunchInfo {
  /** Shown by the player. */
  title: string;
  /** Where in the film to start; 0 or absent for the beginning. */
  positionMs?: number;
}

const xml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * An XSPF playlist for VLC with the start time. XSPF rather than M3U: on Linux VLC owns `.xspf`,
 * while `.m3u` goes to whatever audio player is the default.
 */
export function vlcPlaylist(url: string, title: string, startSeconds: number): Playlist {
  const options = ['http-reconnect', ...(startSeconds > 0 ? [`start-time=${startSeconds}`] : [])];
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/" xmlns:vlc="http://www.videolan.org/vlc/playlist/ns/0/">
  <trackList>
    <track>
      <location>${xml(url)}</location>
      <title>${xml(title)}</title>
      <extension application="http://www.videolan.org/vlc/playlist/0">
        <vlc:id>0</vlc:id>
${options.map((o) => `        <vlc:option>${xml(o)}</vlc:option>`).join('\n')}
      </extension>
    </track>
  </trackList>
</playlist>
`;
  return {
    filename: 'video.xspf',
    href: `data:application/xspf+xml;charset=utf-8,${encodeURIComponent(content)}`,
  };
}

export function detectPlatform(userAgent: string, touchPoints = 0): Platform {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  // iPadOS asks for the desktop site and calls itself a Mac; a Mac has no touch screen.
  if (/macintosh|mac os x/i.test(userAgent)) return touchPoints > 1 ? 'ios' : 'mac';
  // Desktop Linux (Linux Mint and the like); Android was matched above, ChromeOS is not a VLC host.
  if (/linux|x11/i.test(userAgent) && !/cros/i.test(userAgent)) return 'linux';
  return 'other';
}

const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
const seconds = (ms: number | undefined) => Math.max(0, Math.round((ms ?? 0) / 1000));

/**
 * What to do for `platform`: a link into the player's app, or the address to copy where no link is
 * known. `url` is the absolute LAN address of the file; it is normalised, so spaces and brackets in
 * the name are percent-encoded.
 */
export function externalPlayerLink(
  platform: Platform,
  url: string,
  { title, positionMs }: LaunchInfo,
): ExternalLaunch {
  const target = new URL(url);
  const name = oneLine(title) || 'video';
  const start = seconds(positionMs);
  {
    if (platform === 'android') {
      // VLC for Android reads `title` and `position` (ms) from the intent's extras.
      const extras = [
        `S.title=${encodeURIComponent(name)}`,
        ...(start > 0 ? [`l.position=${start * 1000}`] : []),
      ];
      return {
        kind: 'link',
        href:
          `intent://${target.host}${target.pathname}${target.search}#Intent;` +
          `scheme=${target.protocol.replace(':', '')};package=org.videolan.vlc;type=video/*;` +
          `${extras.join(';')};end`,
      };
    }
    if (platform === 'ios') {
      return {
        kind: 'link',
        href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(target.href)}`,
      };
    }
    if (platform === 'mac') {
      // IINA registers `iina://` and plays network streams. VLC for macOS registers no link a web
      // page can open, so the address is copied for it too, and its playlist offered.
      return {
        kind: 'link',
        href:
          `iina://weblink?url=${encodeURIComponent(target.href)}` +
          (start > 0 ? `&mpv_start=${start}` : ''),
        alsoCopy: target.href,
        hint: 'mac',
        playlist: vlcPlaylist(target.href, name, start),
      };
    }
  }
  // VLC on Linux registers no link a web page can open. `scripts/linux/install-vlc-handler.sh`
  // registers `hmc-vlc://` for it; without that nothing happens, so the address is copied as well.
  if (platform === 'linux') {
    return {
      kind: 'link',
      href: `hmc-vlc://open?url=${encodeURIComponent(target.href)}&start=${start}`,
      alsoCopy: target.href,
      hint: 'linux',
      playlist: vlcPlaylist(target.href, name, start),
    };
  }
  // No link a web page can open: hand over the address. Never a file the browser would download.
  return { kind: 'copy', url: target.href };
}
