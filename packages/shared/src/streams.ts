export type StreamKind = 'direct_url' | 'youtube' | 'torrent' | 'external_url' | 'unsupported';

/**
 * One playable choice, as the frontend sees it (ADR-0005). It never carries a URL: the real
 * link, which may hold a provider key, stays in the backend and reaches Kodi only through the
 * loopback relay.
 */
export interface StreamOption {
  /** Opaque; valid for a limited time. */
  id: string;
  title: string;
  kind: StreamKind;
  /** Which debrid service holds it ("torbox", "realdebrid"), if the source says so. */
  service?: string;
  /** `null` when the source does not say. Uncached torrents need an explicit action to start. */
  cached: boolean | null;
  sizeBytes?: number;
  /** Audio languages the source reports, as AIOStreams names them ("Ukrainian", "English"). */
  languages?: string[];
  /** Subtitle languages the source offers, named like `languages`. */
  subtitles?: string[];
  /** "1080p", "2160p"… as reported. */
  resolution?: string;
  /** Source quality as reported: "BluRay", "WEB-DL", "WEBRip"… */
  quality?: string;
  /** False for kinds we cannot play; `reason` says why. */
  playable: boolean;
  reason?: string;
  /** The source played last for this title or episode; listed first. At most one option. */
  lastUsed?: true;
}

export type TitleType = 'movie' | 'series';

/** `GET /titles/:type/:id/streams`. */
export interface StreamsResponse {
  options: StreamOption[];
  /** Titles of per-source failures reported by the provider (one addon down is not fatal). */
  sourceErrors: string[];
  /** Epoch ms, when the provider answered. The list may be served from the cache. */
  fetchedAt: number;
  /** True while a background update is running; the list is replaced when it lands. */
  refreshing: boolean;
  /** Short, no secrets. Set when the last update failed and the cached list is kept. */
  refreshError?: string;
}

/** `GET /streams/cache`: what the source-list cache holds. */
export interface StreamsCacheStats {
  /** Titles with a cached list. */
  entries: number;
  /** Epoch ms of the oldest cached list; absent when empty. */
  oldestFetchedAt?: number;
}

/** `DELETE /streams/cache`. */
export interface StreamsCacheCleared {
  cleared: number;
}
