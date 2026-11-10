import { Injectable } from '@nestjs/common';
import type { PlayedItem } from '@home-media-cast/shared';
import { desc, eq, gte, lt, notInArray } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { playbackHistory } from '../db/schema.js';

export const MAX_AGE_MS = 24 * 3_600_000;
export const MAX_ROWS = 5;

/** What the host keeps about a started play. `releaseKey` never leaves the host. */
export interface HistoryEntry extends Omit<PlayedItem, 'playedAt'> {
  releaseKey: string;
}

export interface StoredHistoryEntry extends HistoryEntry {
  playedAt: number;
}

/** The part of an entry the API may return: everything but the release key. */
export function toPlayedItem(entry: StoredHistoryEntry): PlayedItem {
  const item: PlayedItem & { releaseKey?: string } = { ...entry };
  delete item.releaseKey;
  return item;
}

type Row = typeof playbackHistory.$inferSelect;

const toEntry = (row: Row): StoredHistoryEntry => ({
  id: row.videoId,
  type: row.type as PlayedItem['type'],
  titleId: row.titleId,
  name: row.name,
  ...(row.year ? { year: row.year } : {}),
  ...(row.poster ? { poster: row.poster } : {}),
  ...(row.label ? { label: row.label } : {}),
  releaseTitle: row.releaseTitle,
  ...(row.resolution ? { resolution: row.resolution } : {}),
  ...(row.quality ? { quality: row.quality } : {}),
  releaseKey: row.releaseKey,
  playedAt: row.playedAt,
});

/** The last few plays, in SQLite. Rows hold no link; the release key is for the host only. */
@Injectable()
export class PlaybackHistoryStore {
  constructor(private readonly db: DbService) {}

  /** Adds or refreshes the row of a movie or episode, then drops what is old or beyond the cap. */
  record(entry: HistoryEntry, now = Date.now()): void {
    const values = {
      type: entry.type,
      titleId: entry.titleId,
      name: entry.name,
      year: entry.year ?? null,
      poster: entry.poster ?? null,
      label: entry.label ?? null,
      releaseTitle: entry.releaseTitle,
      resolution: entry.resolution ?? null,
      quality: entry.quality ?? null,
      releaseKey: entry.releaseKey,
      playedAt: now,
    };
    this.db.orm
      .insert(playbackHistory)
      .values({ videoId: entry.id, ...values })
      .onConflictDoUpdate({ target: playbackHistory.videoId, set: values })
      .run();
    this.prune(now);
  }

  /** Fresh rows, newest first, at most `MAX_ROWS`. */
  list(now = Date.now()): StoredHistoryEntry[] {
    return this.db.orm
      .select()
      .from(playbackHistory)
      .where(gte(playbackHistory.playedAt, now - MAX_AGE_MS))
      .orderBy(desc(playbackHistory.playedAt))
      .limit(MAX_ROWS)
      .all()
      .map(toEntry);
  }

  get(videoId: string, now = Date.now()): StoredHistoryEntry | undefined {
    const row = this.db.orm
      .select()
      .from(playbackHistory)
      .where(eq(playbackHistory.videoId, videoId))
      .get();
    return row && row.playedAt >= now - MAX_AGE_MS ? toEntry(row) : undefined;
  }

  private prune(now: number): void {
    this.db.orm
      .delete(playbackHistory)
      .where(lt(playbackHistory.playedAt, now - MAX_AGE_MS))
      .run();
    const keep = this.db.orm
      .select({ id: playbackHistory.videoId })
      .from(playbackHistory)
      .orderBy(desc(playbackHistory.playedAt))
      .limit(MAX_ROWS)
      .all()
      .map((r) => r.id);
    this.db.orm.delete(playbackHistory).where(notInArray(playbackHistory.videoId, keep)).run();
  }
}
