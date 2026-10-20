import { Injectable } from '@nestjs/common';
import type {
  CatalogType,
  HistoryEntry,
  LibraryResponse,
  TitleState,
  TitleSummary,
} from '@home-media-cast/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { progress, titles } from '../db/schema.js';

/** Past this share of the runtime an item counts as watched (credits roll). */
export const WATCHED_AT = 0.9;
/** Shorter than this and a position means nothing (skipped through, or the wrong file). */
const MIN_POSITION_MS = 30_000;

type TitleRow = typeof titles.$inferSelect;
type ProgressRow = typeof progress.$inferSelect;

export interface ProgressInput {
  title: TitleSummary;
  videoId: string;
  season?: number;
  episode?: number;
  label?: string;
  positionMs: number;
  durationMs: number;
}

const summary = (r: TitleRow): TitleSummary => ({
  id: r.id,
  type: r.type as CatalogType,
  name: r.name,
  ...(r.year ? { year: r.year } : {}),
  ...(r.poster ? { poster: r.poster } : {}),
});

const share = (p: ProgressRow): number =>
  p.watched ? 1 : p.durationMs > 0 ? Math.min(1, p.positionMs / p.durationMs) : 0;

/** The household's library in SQLite: liked and saved titles, and watch progress. */
@Injectable()
export class LibraryService {
  constructor(private readonly db: DbService) {}

  /** Remembers a title's card data without touching its flags. */
  remember(t: TitleSummary, now = Date.now()): void {
    this.db.orm
      .insert(titles)
      .values({
        id: t.id,
        type: t.type,
        name: t.name,
        year: t.year ?? null,
        poster: t.poster ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: titles.id,
        set: { name: t.name, year: t.year ?? null, poster: t.poster ?? null, updatedAt: now },
      })
      .run();
  }

  /** Every title the household has liked, saved or played. */
  knownIds(): Set<string> {
    return new Set(
      this.db.orm
        .select({ id: titles.id })
        .from(titles)
        .all()
        .map((r) => r.id),
    );
  }

  state(id: string): TitleState {
    const r = this.db.orm.select().from(titles).where(eq(titles.id, id)).get();
    return { liked: r?.liked ?? false, saved: r?.saved ?? false };
  }

  setState(t: TitleSummary, change: Partial<TitleState>, now = Date.now()): TitleState {
    this.remember(t, now);
    const set: Partial<TitleState> = {};
    if (change.liked !== undefined) set.liked = change.liked;
    if (change.saved !== undefined) set.saved = change.saved;
    if (Object.keys(set).length) {
      this.db.orm.update(titles).set(set).where(eq(titles.id, t.id)).run();
    }
    return this.state(t.id);
  }

  /** Progress of every episode (or the movie) of a title. */
  progressOf(titleId: string): ProgressRow[] {
    return this.db.orm.select().from(progress).where(eq(progress.titleId, titleId)).all();
  }

  /**
   * Stores a position. `watched` is sticky: watching the first half of a finished episode
   * again does not make it unwatched.
   */
  record(input: ProgressInput, now = Date.now()): void {
    const { title, videoId, positionMs, durationMs } = input;
    if (durationMs <= 0 || positionMs < 0) return;
    const finished = positionMs / durationMs >= WATCHED_AT;
    if (!finished && positionMs < MIN_POSITION_MS) return;
    this.remember(title, now);
    const previous = this.db.orm.select().from(progress).where(eq(progress.videoId, videoId)).get();
    const watched = finished || (previous?.watched ?? false);
    const values = {
      positionMs: finished ? 0 : Math.round(positionMs),
      durationMs: Math.round(durationMs),
      watched,
      lastPlayedAt: now,
    };
    this.db.orm
      .insert(progress)
      .values({
        videoId,
        titleId: title.id,
        season: input.season ?? null,
        episode: input.episode ?? null,
        label: input.label ?? null,
        ...values,
      })
      .onConflictDoUpdate({ target: progress.videoId, set: values })
      .run();
  }

  /** Where to pick an unfinished movie or episode up again; undefined if there is no such place. */
  resumePoint(videoId: string): number | undefined {
    const p = this.db.orm.select().from(progress).where(eq(progress.videoId, videoId)).get();
    return p && !p.watched && p.positionMs > 0 ? p.positionMs : undefined;
  }

  /** Marks a movie or an episode watched / unwatched by hand. */
  setWatched(
    input: Omit<ProgressInput, 'positionMs' | 'durationMs'>,
    watched: boolean,
    now = Date.now(),
  ): void {
    this.remember(input.title, now);
    if (!watched) {
      this.db.orm.delete(progress).where(eq(progress.videoId, input.videoId)).run();
      return;
    }
    const values = { watched: true, positionMs: 0, lastPlayedAt: now };
    this.db.orm
      .insert(progress)
      .values({
        videoId: input.videoId,
        titleId: input.title.id,
        season: input.season ?? null,
        episode: input.episode ?? null,
        label: input.label ?? null,
        durationMs: 0,
        ...values,
      })
      .onConflictDoUpdate({ target: progress.videoId, set: values })
      .run();
  }

  overview(): LibraryResponse {
    const rows = this.db.orm.select().from(progress).orderBy(desc(progress.lastPlayedAt)).all();
    const ids = [...new Set(rows.map((r) => r.titleId))];
    const byId = new Map<string, TitleRow>();
    if (ids.length) {
      for (const r of this.db.orm.select().from(titles).where(inArray(titles.id, ids)).all()) {
        byId.set(r.id, r);
      }
    }
    const entry = (p: ProgressRow): HistoryEntry | undefined => {
      const t = byId.get(p.titleId);
      if (!t) return undefined;
      return {
        ...summary(t),
        videoId: p.videoId,
        ...(p.season !== null && p.episode !== null
          ? { label: `S${p.season}E${p.episode}${p.label ? ` · ${p.label}` : ''}` }
          : {}),
        watched: p.watched,
        progress: share(p),
        lastPlayedAt: p.lastPlayedAt,
      };
    };
    const history = rows.slice(0, 50).flatMap((p) => entry(p) ?? []);
    const seen = new Set<string>();
    const continueWatching: HistoryEntry[] = [];
    for (const p of rows) {
      if (seen.has(p.titleId)) continue; // only the latest item of each title counts
      seen.add(p.titleId);
      const e = !p.watched && p.positionMs > 0 ? entry(p) : undefined;
      if (e) continueWatching.push(e);
      if (continueWatching.length >= 20) break;
    }
    const flagged = (flag: 'liked' | 'saved') =>
      this.db.orm
        .select()
        .from(titles)
        .where(eq(titles[flag], true))
        .orderBy(desc(titles.updatedAt))
        .all()
        .map(summary);
    return { continueWatching, favorites: flagged('liked'), saved: flagged('saved'), history };
  }
}
