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
  /**
   * Audio languages, as AIOStreams names them ("Ukrainian", "English"). What the source reports,
   * until the file itself was read: then these are its real tracks and `audioVerified` is set.
   */
  languages?: string[];
  /** `languages` come from the audio tracks of the file, not from the release name. */
  audioVerified?: true;
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

/** One audio track read from the file's own header. */
export interface AudioTrack {
  /** English name ("Ukrainian"); absent when the file leaves the language unset. */
  language?: string;
  /** "AAC", "AC3", "E-AC3", "DTS", "TrueHD"... */
  codec?: string;
  channels?: number;
  /** The track's own title, e.g. "Ukrainian 5.1 (Dubbing)"; cut to a short length. */
  title?: string;
}

/**
 * `GET /streams/options/:id/audio`. `unavailable` covers every reason the file could not be read
 * (not cached, unknown container, provider error); the list keeps the languages it already has.
 */
export type AudioProbeResponse =
  { status: 'ok'; tracks: AudioTrack[]; languages: string[] } | { status: 'unavailable' };

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
