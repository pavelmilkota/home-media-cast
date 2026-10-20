import { z } from 'zod';

export type CatalogType = 'movie' | 'series';

/** One search hit or library card. Poster is an https URL on the metadata provider's CDN. */
export interface TitleSummary {
  /** IMDb id, `tt0111161`. */
  id: string;
  type: CatalogType;
  name: string;
  year?: string;
  poster?: string;
}

/** What this household has done with a title. */
export interface TitleState {
  liked: boolean;
  /** On the "My list" shelf. */
  saved: boolean;
}

export interface EpisodeInfo {
  /** `tt0903747:1:2`, the id the sources endpoint takes. */
  id: string;
  season: number;
  episode: number;
  name: string;
  overview?: string;
  /** ISO date; absent when unknown. */
  firstAired?: string;
  /** Still image of the episode, an https URL on the metadata provider's CDN. */
  thumbnail?: string;
  /** False for episodes that have not aired yet. */
  released: boolean;
  watched: boolean;
  /** 0..1, only for an episode that was started and not finished. */
  progress?: number;
}

export interface TitleDetail extends TitleSummary {
  description?: string;
  rating?: string;
  runtime?: string;
  genres: string[];
  cast: string[];
  background?: string;
  /** YouTube video id of a trailer; present when one can be played (`POST /catalog/:type/:id/trailer`). */
  trailer?: string;
  state: TitleState;
  /** Movies: has it been watched to the end. */
  watched: boolean;
  /** Movies: 0..1 when started and not finished. */
  progress?: number;
  /** Series only. Season 0 holds specials. */
  episodes: EpisodeInfo[];
  /** Series only: the episode to play next (the one in progress, else the first unwatched). */
  nextUp?: string;
}

export interface SearchResponse {
  results: TitleSummary[];
}

export interface HistoryEntry extends TitleSummary {
  /** Movie id, or the episode id for a series. */
  videoId: string;
  /** "S1E4 · Name" for an episode. */
  label?: string;
  watched: boolean;
  /** 0..1 */
  progress: number;
  lastPlayedAt: number;
}

export interface LibraryResponse {
  continueWatching: HistoryEntry[];
  favorites: TitleSummary[];
  saved: TitleSummary[];
  history: HistoryEntry[];
}

export const TitleStateSchema = z.strictObject({
  liked: z.boolean().optional(),
  saved: z.boolean().optional(),
});
export type TitleStateDto = z.infer<typeof TitleStateSchema>;

export const WatchedSchema = z.strictObject({ watched: z.boolean() });
export type WatchedDto = z.infer<typeof WatchedSchema>;

/** An episode next to the one last played from the catalog. */
export interface EpisodeRef {
  /** `tt0903747:1:3` */
  videoId: string;
  seriesName: string;
  /** "S1E3 · Name" */
  label: string;
}

/**
 * `GET /playback/episodes`: the aired episodes before and after the last one played from the
 * catalog. Each is absent when it does not exist or the last play was not an episode.
 */
export interface AdjacentEpisodes {
  previous?: EpisodeRef;
  next?: EpisodeRef;
}

/** An item waiting in the play queue. The source is chosen again when its turn comes. */
export interface QueueEntry {
  id: string;
  type: CatalogType;
  /** Movie id, or the episode id for a series. */
  videoId: string;
  name: string;
  /** "S1E4 · Name" for an episode. */
  label?: string;
}

export interface QueueResponse {
  items: QueueEntry[];
}

export const QueueAddSchema = z.strictObject({
  /** A source the household picked for this title; only its release group is remembered. */
  optionId: z.string().min(1).max(64),
  title: z.strictObject({
    type: z.enum(['movie', 'series']),
    id: z.string().regex(/^tt\d{1,10}(:\d{1,3}:\d{1,4})?$/),
  }),
});
export type QueueAddDto = z.infer<typeof QueueAddSchema>;

export const MOVIE_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Biography',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Sport',
  'Thriller',
  'War',
  'Western',
] as const;
export const SERIES_GENRES = [...MOVIE_GENRES, 'Reality-TV', 'Talk-Show', 'Game-Show'] as const;

/** Cinemeta's lists: `popular` (top), `new` (by year) and `featured` (best rated). */
export const BROWSE_LISTS = ['popular', 'new', 'featured'] as const;
export type BrowseList = (typeof BROWSE_LISTS)[number];

/** Query of `GET /catalog/browse`. `genre` is a genre name, or a four-digit year for `new`. */
export const BrowseQuerySchema = z
  .strictObject({
    type: z.enum(['movie', 'series']),
    list: z.enum(BROWSE_LISTS),
    genre: z.string().max(20).optional(),
    skip: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.genre === undefined) return;
    const allowed: readonly string[] = q.type === 'movie' ? MOVIE_GENRES : SERIES_GENRES;
    const ok = q.list === 'new' ? /^(19|20)\d\d$/.test(q.genre) : allowed.includes(q.genre);
    if (!ok) ctx.addIssue({ code: 'custom', path: ['genre'], message: 'Unknown genre' });
  });
export type BrowseQuery = z.infer<typeof BrowseQuerySchema>;

export interface BrowseResponse {
  results: TitleSummary[];
  /** Pass as `skip` for the next page; absent when the list has ended. */
  nextSkip?: number;
}
