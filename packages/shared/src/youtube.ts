/** What a pasted or shared YouTube link asks for. */
export interface YouTubeLink {
  videoId: string;
  /** Start offset in seconds, from `t=` / `start=`. Absent when there is none or it is invalid. */
  startSeconds?: number;
  /** Playlist id from `list=`. Parsed for completeness; playback does not use it yet. */
  listId?: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const MAX_START_SECONDS = 24 * 3600;

/** Exact hosts only: `evil-youtube.com` and `youtube.com.evil.net` must not match. */
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const SHORT_HOST = 'youtu.be';
/** `/shorts/<id>`, `/embed/<id>`, `/live/<id>`, `/v/<id>`. */
const ID_IN_PATH = /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/;

/** `90`, `90s`, `1m30s`, `1h2m3s`. Anything else is not a start time. */
export function parseStartSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 && seconds <= MAX_START_SECONDS ? seconds : undefined;
}

/**
 * Extracts the video from a YouTube link, or returns undefined for anything else. It never
 * returns more than a validated 11-character id, so nothing a user pastes can steer the
 * `plugin://` URL that Kodi opens (ADR-0003).
 */
export function parseYouTubeUrl(raw: string): YouTubeLink | undefined {
  const text = raw.trim();
  if (text.length === 0 || text.length > 4096) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.port) return undefined;

  const host = url.hostname.toLowerCase();
  let videoId: string | undefined;
  if (host === SHORT_HOST) {
    videoId = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  } else if (HOSTS.has(host)) {
    videoId =
      url.pathname === '/watch' || url.pathname === '/watch/'
        ? (url.searchParams.get('v') ?? undefined)
        : ID_IN_PATH.exec(url.pathname)?.[1];
  } else {
    return undefined;
  }
  if (!videoId || !VIDEO_ID.test(videoId)) return undefined;

  const startSeconds = parseStartSeconds(
    url.searchParams.get('t') ?? url.searchParams.get('start'),
  );
  const list = url.searchParams.get('list');
  return {
    videoId,
    ...(startSeconds !== undefined ? { startSeconds } : {}),
    ...(list && LIST_ID.test(list) ? { listId: list } : {}),
  };
}
