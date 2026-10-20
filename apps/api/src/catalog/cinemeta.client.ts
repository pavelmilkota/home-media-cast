import { z } from 'zod';
import type { CatalogType } from '@home-media-cast/shared';

/** The metadata service cannot be reached or sent something unreadable. */
export class MetadataUnavailableError extends Error {
  override readonly name = 'MetadataUnavailableError';
}

/** The metadata service does not know this title. */
export class TitleNotFoundError extends Error {
  override readonly name = 'TitleNotFoundError';
}

export const DEFAULT_CINEMETA_URL = 'https://v3-cinemeta.strem.io';

export interface CinemetaOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** How long an answer is reused. Metadata changes slowly; ADR-0006 suggests about a day. */
  ttlMs?: number;
  fetchFn?: typeof fetch;
}

export interface MetaHit {
  id: string;
  type: CatalogType;
  name: string;
  year?: string;
  poster?: string;
}

export interface MetaVideo {
  id: string;
  season: number;
  episode: number;
  name: string;
  overview?: string;
  firstAired?: string;
  thumbnail?: string;
}

export interface Meta extends MetaHit {
  description?: string;
  rating?: string;
  runtime?: string;
  genres: string[];
  cast: string[];
  background?: string;
  /** YouTube video id of the first trailer, when Cinemeta lists one. */
  trailer?: string;
  videos: MetaVideo[];
}

/** Gateway errors that real Cinemeta gives a cold request; the same request then succeeds. */
const RETRYABLE = new Set([502, 503, 504]);

const ID = /^tt\d{1,10}$/;
export const isImdbId = (id: string): boolean => ID.test(id);

/** Posters and backgrounds are shown by the browser: https only, nothing else is passed on. */
const imageUrl = (v: unknown): string | undefined =>
  typeof v === 'string' && /^https:\/\//i.test(v) && v.length < 500 ? v : undefined;

const text = (v: unknown, max = 2000): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const Hit = z.object({
  id: z.string(),
  imdb_id: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  releaseInfo: z.string().optional(),
  year: z.string().optional(),
  poster: z.string().optional(),
});
const Search = z.object({ metas: z.array(z.unknown()).default([]) });

const Video = z.object({
  id: z.string(),
  season: z.number().optional(),
  number: z.number().optional(),
  episode: z.number().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  overview: z.string().optional(),
  firstAired: z.string().optional(),
  released: z.string().optional(),
  thumbnail: z.string().optional(),
});
const Trailer = z.object({ source: z.string(), type: z.string().optional() });
const YOUTUBE_ID = /^[\w-]{11}$/;

const MetaEnvelope = z.object({
  meta: z
    .object({
      id: z.string().optional(),
      imdb_id: z.string().optional(),
      name: z.string().optional(),
      releaseInfo: z.string().optional(),
      year: z.string().optional(),
      poster: z.string().optional(),
      background: z.string().optional(),
      description: z.string().optional(),
      imdbRating: z.string().optional(),
      runtime: z.string().optional(),
      genres: z.array(z.string()).optional(),
      cast: z.array(z.string()).optional(),
      videos: z.array(z.unknown()).optional(),
      trailers: z.array(z.unknown()).optional(),
    })
    .optional(),
});

interface Cached<T> {
  value: T;
  expiresAt: number;
}

/**
 * Cinemeta, Stremio's public metadata addon (ADR-0006). Keyed by IMDb id, which is also what
 * AIOStreams takes. Answers are kept in memory for `ttlMs`.
 * ⚠️ Cinemeta publishes no terms of use or rate limits; keep requests few.
 */
export class CinemetaClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly cache = new Map<string, Cached<unknown>>();

  constructor(options: CinemetaOptions = {}) {
    this.base = (options.baseUrl ?? DEFAULT_CINEMETA_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.ttlMs = options.ttlMs ?? 6 * 3_600_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async search(type: CatalogType, query: string): Promise<MetaHit[]> {
    const q = query.trim().slice(0, 100);
    if (!q) return [];
    return this.hits(type, `/catalog/${type}/top/search=${encodeURIComponent(q)}.json`);
  }

  /** The provider's "popular" catalog, most popular first. */
  top(type: CatalogType): Promise<MetaHit[]> {
    return this.hits(type, `/catalog/${type}/top.json`);
  }

  /** One page of a catalog: `top` (popular), `year` (new; the genre is a year) or `imdbRating`. */
  browse(
    type: CatalogType,
    catalog: 'top' | 'year' | 'imdbRating',
    genre?: string,
    skip?: number,
  ): Promise<MetaHit[]> {
    const extra = [
      genre ? `genre=${encodeURIComponent(genre)}` : undefined,
      skip ? `skip=${skip}` : undefined,
    ].filter(Boolean);
    return this.hits(
      type,
      `/catalog/${type}/${catalog}${extra.length ? `/${extra.join('&')}` : ''}.json`,
    );
  }

  private async hits(type: CatalogType, path: string): Promise<MetaHit[]> {
    const body = await this.get(path);
    const parsed = Search.safeParse(body);
    if (!parsed.success) throw new MetadataUnavailableError('Metadata sent an unreadable answer');
    const hits: MetaHit[] = [];
    for (const raw of parsed.data.metas) {
      const h = Hit.safeParse(raw);
      const id = h.success ? (h.data.imdb_id ?? h.data.id) : undefined;
      if (!h.success || !id || !ID.test(id) || !h.data.name) continue;
      hits.push({
        id,
        type,
        name: h.data.name.slice(0, 200),
        ...opt('year', text(h.data.releaseInfo ?? h.data.year, 20)),
        ...opt('poster', imageUrl(h.data.poster)),
      });
    }
    return hits;
  }

  async meta(type: CatalogType, id: string): Promise<Meta> {
    if (!ID.test(id)) throw new RangeError('Not an IMDb id');
    const body = await this.get(`/meta/${type}/${id}.json`);
    const parsed = MetaEnvelope.safeParse(body);
    if (!parsed.success) throw new MetadataUnavailableError('Metadata sent an unreadable answer');
    const m = parsed.data.meta;
    if (!m?.name) throw new TitleNotFoundError('Unknown title');
    const videos: MetaVideo[] = [];
    for (const raw of m.videos ?? []) {
      const v = Video.safeParse(raw);
      if (!v.success) continue;
      const season = v.data.season;
      const episode = v.data.number ?? v.data.episode;
      if (season === undefined || episode === undefined) continue;
      if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 1) {
        continue;
      }
      videos.push({
        id: `${id}:${season}:${episode}`,
        season,
        episode,
        name: text(v.data.name ?? v.data.title, 200) ?? `Episode ${episode}`,
        ...opt('overview', text(v.data.overview)),
        ...opt('firstAired', text(v.data.firstAired ?? v.data.released, 40)),
        ...opt('thumbnail', imageUrl(v.data.thumbnail)),
      });
    }
    const trailer = (m.trailers ?? [])
      .map((raw) => Trailer.safeParse(raw))
      .find((t) => t.success && t.data.type !== 'Teaser' && YOUTUBE_ID.test(t.data.source));
    videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return {
      id,
      type,
      name: m.name.slice(0, 200),
      ...opt('year', text(m.releaseInfo ?? m.year, 20)),
      ...opt('poster', imageUrl(m.poster)),
      ...opt('background', imageUrl(m.background)),
      ...opt('trailer', trailer?.success ? trailer.data.source : undefined),
      ...opt('description', text(m.description)),
      ...opt('rating', text(m.imdbRating, 10)),
      ...opt('runtime', text(m.runtime, 30)),
      genres: (m.genres ?? []).slice(0, 8).map((g) => g.slice(0, 40)),
      cast: (m.cast ?? []).slice(0, 8).map((g) => g.slice(0, 80)),
      videos,
    };
  }

  private async fetchOnce(path: string): Promise<Response> {
    try {
      return await this.fetchFn(this.base + path, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MetadataUnavailableError('Metadata is not reachable');
    }
  }

  private async get(path: string): Promise<unknown> {
    const hit = this.cache.get(path);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    let res = await this.fetchOnce(path);
    // Real Cinemeta answers a cold request with a Cloudflare 502/503/504 after ~6 s and serves the
    // same request quickly once its origin has warmed up, so one retry usually succeeds.
    if (RETRYABLE.has(res.status)) res = await this.fetchOnce(path);
    if (res.status === 404) throw new TitleNotFoundError('Unknown title');
    if (!res.ok) throw new MetadataUnavailableError(`Metadata answered ${res.status}`);
    const body: unknown = await res.json().catch(() => undefined);
    if (body === undefined)
      throw new MetadataUnavailableError('Metadata sent an unreadable answer');
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(path, { value: body, expiresAt: Date.now() + this.ttlMs });
    return body;
  }
}

/** `{ key: value }`, or nothing when the value is missing (keeps optional fields absent). */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}
