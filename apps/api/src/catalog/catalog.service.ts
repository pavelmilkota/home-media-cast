import { Injectable } from '@nestjs/common';
import type {
  BrowseQuery,
  BrowseResponse,
  CatalogType,
  EpisodeInfo,
  AdjacentEpisodes,
  EpisodeRef,
  SearchResponse,
  TitleDetail,
  TitleState,
  TitleSummary,
} from '@home-media-cast/shared';
import {
  type CinemetaClient,
  type Meta,
  type MetaHit,
  MetadataUnavailableError,
  isImdbId,
} from './cinemeta.client.js';
import type { LibraryService, ProgressInput } from './library.service.js';

/** `tt0903747` or `tt0903747:1:2`. */
const VIDEO_ID = /^(tt\d{1,10})(?::(\d{1,3}):(\d{1,4}))?$/;

export function parseVideoId(
  videoId: string,
): { titleId: string; season?: number; episode?: number } | undefined {
  const m = VIDEO_ID.exec(videoId);
  if (!m) return undefined;
  return m[2] === undefined
    ? { titleId: m[1]! }
    : { titleId: m[1]!, season: Number(m[2]), episode: Number(m[3]) };
}

const summary = (m: MetaHit): TitleSummary => ({
  id: m.id,
  type: m.type,
  name: m.name,
  ...(m.year ? { year: m.year } : {}),
  ...(m.poster ? { poster: m.poster } : {}),
});

/** Searches the metadata provider and joins its answers with the household's library. */
@Injectable()
export class CatalogService {
  constructor(
    private readonly meta: CinemetaClient,
    private readonly library: LibraryService,
  ) {}

  async search(query: string): Promise<SearchResponse> {
    return { results: (await this.both((t) => this.meta.search(t, query))).slice(0, 30) };
  }

  /** What is popular right now, minus titles the household already has in its library. */
  async discover(limit = 8): Promise<SearchResponse> {
    const known = this.library.knownIds();
    const all = await this.both((t) => this.meta.top(t));
    return { results: all.filter((t) => !known.has(t.id)).slice(0, limit) };
  }

  /** One page of a provider list; `new` defaults to the current year. */
  async browse(q: BrowseQuery, now = new Date()): Promise<BrowseResponse> {
    const catalog = { popular: 'top', new: 'year', featured: 'imdbRating' }[q.list] as
      'top' | 'year' | 'imdbRating';
    const genre = q.list === 'new' ? (q.genre ?? String(now.getFullYear())) : q.genre;
    const skip = q.skip ?? 0;
    const hits = await this.meta.browse(q.type, catalog, genre, skip);
    return {
      results: hits.map(summary),
      ...(hits.length > 0 ? { nextSkip: skip + hits.length } : {}),
    };
  }

  /** Movies and series from one provider call each, interleaved; one failing is tolerated. */
  private async both(fetchOf: (type: CatalogType) => Promise<MetaHit[]>): Promise<TitleSummary[]> {
    const [movies, series] = await Promise.allSettled([fetchOf('movie'), fetchOf('series')]);
    if (movies.status === 'rejected' && series.status === 'rejected') throw movies.reason;
    const m = movies.status === 'fulfilled' ? movies.value : [];
    const s = series.status === 'fulfilled' ? series.value : [];
    // Interleave so a series does not hide behind ten films with the same word in the name.
    const results: TitleSummary[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < Math.max(m.length, s.length); i++) {
      for (const hit of [m[i], s[i]]) {
        if (hit && !seen.has(hit.id)) {
          seen.add(hit.id);
          results.push(summary(hit));
        }
      }
    }
    return results;
  }

  /** The YouTube id of the title's trailer, or undefined when Cinemeta lists none. */
  async trailerId(type: CatalogType, id: string): Promise<string | undefined> {
    return (await this.meta.meta(type, id)).trailer;
  }

  async detail(type: CatalogType, id: string, now = Date.now()): Promise<TitleDetail> {
    const meta = await this.meta.meta(type, id);
    const rows = new Map(this.library.progressOf(id).map((p) => [p.videoId, p]));
    const episodes: EpisodeInfo[] = meta.videos.map((v) => {
      const p = rows.get(v.id);
      const progress = p && !p.watched && p.durationMs > 0 ? p.positionMs / p.durationMs : 0;
      return {
        id: v.id,
        season: v.season,
        episode: v.episode,
        name: v.name,
        ...(v.overview ? { overview: v.overview } : {}),
        ...(v.firstAired ? { firstAired: v.firstAired } : {}),
        ...(v.thumbnail ? { thumbnail: v.thumbnail } : {}),
        released: !v.firstAired || !(Date.parse(v.firstAired) > now),
        watched: p?.watched ?? false,
        ...(progress > 0 ? { progress } : {}),
      };
    });
    const own = rows.get(id);
    const ownProgress =
      own && !own.watched && own.durationMs > 0 ? own.positionMs / own.durationMs : 0;
    const nextUp = type === 'series' ? this.nextUp(episodes, rows) : undefined;
    return {
      ...summary(meta),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.rating ? { rating: meta.rating } : {}),
      ...(meta.runtime ? { runtime: meta.runtime } : {}),
      ...(meta.background ? { background: meta.background } : {}),
      ...(meta.trailer ? { trailer: meta.trailer } : {}),
      genres: meta.genres,
      cast: meta.cast,
      state: this.library.state(id),
      watched: own?.watched ?? false,
      ...(ownProgress > 0 ? { progress: ownProgress } : {}),
      episodes,
      ...(nextUp ? { nextUp } : {}),
    };
  }

  async setState(type: CatalogType, id: string, change: Partial<TitleState>): Promise<TitleState> {
    return this.library.setState(summary(await this.meta.meta(type, id)), change);
  }

  async setWatched(type: CatalogType, videoId: string, watched: boolean): Promise<void> {
    const ctx = await this.context(type, videoId);
    if (!ctx) throw new RangeError('Not a valid video id');
    this.library.setWatched(ctx, watched);
  }

  /** Marks every aired episode of a season watched / unwatched; unaired ones are left alone. */
  async setSeasonWatched(id: string, season: number, watched: boolean): Promise<void> {
    const meta = await this.meta.meta('series', id);
    const title = summary(meta);
    const now = Date.now();
    for (const v of meta.videos) {
      if (v.season !== season || (v.firstAired && Date.parse(v.firstAired) > now)) continue;
      this.library.setWatched(
        { title, videoId: v.id, season: v.season, episode: v.episode, label: v.name },
        watched,
      );
    }
  }

  resumePoint(videoId: string): number | undefined {
    return this.library.resumePoint(videoId);
  }

  /** The release last played for a movie or an episode (host only; never sent to the phone). */
  lastReleaseOf(videoId: string): string | undefined {
    return this.library.lastReleaseOf(videoId);
  }

  /** The aired episodes right before and after `videoId`, in season order (specials skipped). */
  async neighbors(videoId: string): Promise<AdjacentEpisodes> {
    const parsed = parseVideoId(videoId);
    if (!parsed || parsed.season === undefined) return {};
    const meta = await this.meta.meta('series', parsed.titleId);
    const aired = meta.videos.filter(
      (v) => v.season > 0 && !(v.firstAired && Date.parse(v.firstAired) > Date.now()),
    );
    const at = aired.findIndex((v) => v.id === videoId);
    if (at < 0) return {};
    const ref = (v: (typeof aired)[number] | undefined): EpisodeRef | undefined =>
      v
        ? { videoId: v.id, seriesName: meta.name, label: `S${v.season}E${v.episode} · ${v.name}` }
        : undefined;
    const previous = ref(aired[at - 1]);
    const next = ref(aired[at + 1]);
    return { ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
  }

  /** Card data, season, episode and name for an item about to be played or marked. */
  async context(
    type: CatalogType,
    videoId: string,
  ): Promise<Omit<ProgressInput, 'positionMs' | 'durationMs'> | undefined> {
    const parsed = parseVideoId(videoId);
    if (!parsed || !isImdbId(parsed.titleId)) return undefined;
    if ((type === 'series') !== (parsed.season !== undefined)) return undefined;
    const meta: Meta = await this.meta.meta(type, parsed.titleId);
    const video = meta.videos.find((v) => v.id === videoId);
    return {
      title: summary(meta),
      videoId,
      ...(parsed.season !== undefined
        ? {
            season: parsed.season,
            episode: parsed.episode!,
            ...(video ? { label: video.name } : {}),
          }
        : {}),
    };
  }

  /** Like `context`, but a metadata outage is not an error: playback must not depend on it. */
  async contextOrUndefined(type: CatalogType, videoId: string) {
    try {
      return await this.context(type, videoId);
    } catch (e) {
      if (e instanceof MetadataUnavailableError) return undefined;
      throw e;
    }
  }

  private nextUp(
    episodes: EpisodeInfo[],
    rows: Map<string, { lastPlayedAt: number; watched: boolean }>,
  ): string | undefined {
    const order = episodes.filter((e) => e.season > 0 && e.released);
    if (!order.length) return undefined;
    let last: { index: number; at: number } | undefined;
    order.forEach((e, index) => {
      const p = rows.get(e.id);
      if (p && (!last || p.lastPlayedAt > last.at)) last = { index, at: p.lastPlayedAt };
    });
    if (!last) return order[0]!.id;
    const current = order[last.index]!;
    if (!current.watched) return current.id;
    return order.slice(last.index + 1).find((e) => !e.watched)?.id;
  }
}
