import type { StreamKind, StreamOption } from '@home-media-cast/shared';
import { YOUTUBE_VIDEO_ID, safeTitle } from '../kodi/kodi.commands.js';

/**
 * What a result from a stream provider turns into, with the provider's URL still inside. This
 * type lives in the backend only; `toOption` is the single way out to the frontend (ADR-0005).
 */
export type StreamSource =
  | { kind: 'direct_url'; url: string; headers: Record<string, string> }
  | { kind: 'youtube'; videoId: string }
  | { kind: 'torrent'; infoHash: string; fileIdx?: number }
  | { kind: 'external_url'; url: string }
  | { kind: 'unsupported'; reason: string };

export interface ClassifiedResult {
  source: StreamSource;
  title: string;
  service?: string;
  cached: boolean | null;
  sizeBytes?: number;
  languages?: string[];
  resolution?: string;
  /** Same value across the episodes of one release; used to pick the next episode's source. */
  bingeGroup?: string;
  /** The torrent behind the result; one season pack has the same hash for all its episodes. */
  infoHash?: string;
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const INFO_HASH = /^[0-9a-f]{40}$/i;
/** Fields of a Stremio / AIOStreams result that point at something we do not play. */
const UNSUPPORTED_FIELDS = ['nzbUrl', 'rarUrls', 'zipUrls', '7zipUrls', 'tarUrls', 'tgzUrls'];
const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v !== '' : v != null && v !== false;

/**
 * AIOStreams reports parsed file data either on the result or under `parsedFile`; both
 * places are read, because the exact shape of `SearchResult` is not published.
 */
function parsed(raw: Raw, key: string): unknown {
  const file = raw['parsedFile'];
  return raw[key] ?? (file && typeof file === 'object' ? (file as Raw)[key] : undefined);
}

/** "Movie.2160p.HDR.mkv" -> "2160p"; "4K"/"UHD" -> "2160p". Only used when the result has none. */
export function resolutionFromName(name: string): string | undefined {
  const p = /(?<![0-9a-z])(2160|1440|1080|720|576|480)[pi](?![a-z])/i.exec(name);
  if (p) return `${p[1]}p`;
  return /(?<![0-9a-z])(4k|uhd)(?![0-9a-z])/i.test(name) ? '2160p' : undefined;
}

function languagesOf(raw: Raw): string[] {
  const value = parsed(raw, 'languages');
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    const lang = typeof v === 'string' ? v.trim() : '';
    if (lang && lang.length <= 30) seen.add(lang);
  }
  return [...seen].slice(0, 6);
}

function headersOf(raw: Raw): Record<string, string> {
  const h = raw['requestHeaders'];
  if (!h || typeof h !== 'object') return {};
  return Object.fromEntries(
    Object.entries(h).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

function classifySource(raw: Raw): StreamSource {
  const ytId = str(raw['ytId']);
  if (ytId) {
    return YOUTUBE_VIDEO_ID.test(ytId)
      ? { kind: 'youtube', videoId: ytId }
      : { kind: 'unsupported', reason: 'Invalid YouTube id' };
  }
  const url = str(raw['url']);
  if (url) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      return { kind: 'unsupported', reason: 'Not a valid URL' };
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { kind: 'direct_url', url, headers: headersOf(raw) };
    }
    // Name the scheme only; never echo the rest of the URL.
    return {
      kind: 'unsupported',
      reason: `Unsupported link type (${parsed.protocol.slice(0, -1)})`,
    };
  }
  const external = str(raw['externalUrl']);
  if (external) return { kind: 'external_url', url: external };
  const unsupported = UNSUPPORTED_FIELDS.find((f) => nonEmpty(raw[f]));
  if (unsupported) {
    return { kind: 'unsupported', reason: `Unsupported source type (${unsupported})` };
  }
  const infoHash = str(raw['infoHash']);
  if (infoHash) {
    return INFO_HASH.test(infoHash)
      ? {
          kind: 'torrent',
          infoHash: infoHash.toLowerCase(),
          ...(num(raw['fileIdx']) !== undefined ? { fileIdx: num(raw['fileIdx']) as number } : {}),
        }
      : { kind: 'unsupported', reason: 'Invalid info hash' };
  }
  return { kind: 'unsupported', reason: 'Nothing to play in this result' };
}

/**
 * Turns one AIOStreams `SearchResult` (or a plain Stremio stream) into a source plus display
 * data. Never throws: a result we cannot read becomes `unsupported`, so one bad entry cannot
 * hide the rest of a list.
 */
export function classifyResult(input: unknown): ClassifiedResult {
  const raw: Raw = input && typeof input === 'object' ? (input as Raw) : {};
  const title = safeTitle({
    title: str(raw['filename']) ?? str(raw['folderName']) ?? str(raw['name']) ?? '',
  });
  const languages = languagesOf(raw);
  const resolution =
    str(parsed(raw, 'resolution')) ??
    resolutionFromName(str(raw['filename']) ?? str(raw['folderName']) ?? '');
  const bingeGroup =
    str(raw['bingeGroup']) ?? str((raw['behaviorHints'] as Raw | undefined)?.['bingeGroup']);
  const infoHash = str(raw['infoHash']);
  return {
    source: classifySource(raw),
    title: title || 'Untitled stream',
    ...(str(raw['service']) ? { service: (str(raw['service']) as string).toLowerCase() } : {}),
    cached: typeof raw['cached'] === 'boolean' ? raw['cached'] : null,
    ...(num(raw['size']) !== undefined ? { sizeBytes: num(raw['size']) as number } : {}),
    ...(languages.length ? { languages } : {}),
    ...(resolution && resolution.length <= 12 ? { resolution } : {}),
    ...(bingeGroup && bingeGroup.length <= 300 ? { bingeGroup } : {}),
    ...(infoHash && INFO_HASH.test(infoHash) ? { infoHash: infoHash.toLowerCase() } : {}),
  };
}

/** What identifies a source across episodes; opaque outside this file and stays in the backend. */
interface Release {
  g?: string;
  r: string;
  l: string[];
  h?: string;
}

/**
 * Identifies the release behind a source. AIOStreams' `bingeGroup` is coarse (for example
 * `addon|1080p|BluRay` is shared by many unrelated torrents), so the torrent's info hash comes
 * first; the group plus resolution and languages is the fallback for releases that ship one
 * torrent per episode. Undefined when the source names neither.
 */
export function releaseKey(c: ClassifiedResult): string | undefined {
  if (!c.bingeGroup && !c.infoHash) return undefined;
  const release: Release = {
    ...(c.bingeGroup ? { g: c.bingeGroup } : {}),
    r: c.resolution ?? '',
    l: [...(c.languages ?? [])].sort(),
    ...(c.infoHash ? { h: c.infoHash } : {}),
  };
  return JSON.stringify(release);
}

/** How well a candidate matches a `releaseKey`: 2 same torrent, 1 same group variant, 0 no. */
export function releaseMatch(key: string, c: ClassifiedResult): 0 | 1 | 2 {
  const want = JSON.parse(key) as Release;
  if (want.h && c.infoHash === want.h) return 2;
  const have = JSON.parse(releaseKey(c) ?? '{}') as Partial<Release>;
  return want.g && have.g === want.g && have.r === want.r && have.l?.join() === want.l.join()
    ? 1
    : 0;
}

/** `torrent` joins this set when the TorBox client can add one on an explicit request (Phase 4). */
const PLAYABLE: ReadonlySet<StreamKind> = new Set(['direct_url', 'youtube']);

/** The only shape that leaves the backend. Contains no URL, hash or header. */
export function toOption(id: string, c: ClassifiedResult): StreamOption {
  const kind = c.source.kind;
  const playable = PLAYABLE.has(kind);
  return {
    id,
    title: c.title,
    kind,
    ...(c.service ? { service: c.service } : {}),
    cached: c.cached,
    ...(c.sizeBytes !== undefined ? { sizeBytes: c.sizeBytes } : {}),
    ...(c.languages ? { languages: c.languages } : {}),
    ...(c.resolution ? { resolution: c.resolution } : {}),
    playable,
    ...(c.source.kind === 'unsupported'
      ? { reason: c.source.reason }
      : kind === 'external_url'
        ? { reason: 'Opens in a browser, not on the TV' }
        : kind === 'torrent'
          ? { reason: 'Needs a debrid service to add it (not available yet)' }
          : {}),
  };
}
