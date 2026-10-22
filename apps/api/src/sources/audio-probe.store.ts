import { Injectable } from '@nestjs/common';
import type { AudioTrack } from '@home-media-cast/shared';
import { asc, count, eq, inArray, lt } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { audioProbe } from '../db/schema.js';

/** A file does not change, so tracks stay; "nothing found" is looked at again after a week. */
const TRACKS_MAX_AGE_MS = 180 * 24 * 3_600_000;
const EMPTY_MAX_AGE_MS = 7 * 24 * 3_600_000;
const MAX_ROWS = 5000;
/** Below SQLite's bound-variable limit. */
const CHUNK = 500;

/** The audio tracks found in files, in SQLite. Rows hold no link and no secret. */
@Injectable()
export class AudioProbeStore {
  constructor(private readonly db: DbService) {}

  /** The tracks stored for each key that has a fresh row (an empty list is a real answer). */
  getMany(keys: string[], now = Date.now()): Map<string, AudioTrack[]> {
    const found = new Map<string, AudioTrack[]>();
    for (let i = 0; i < keys.length; i += CHUNK) {
      const rows = this.db.orm
        .select()
        .from(audioProbe)
        .where(inArray(audioProbe.key, keys.slice(i, i + CHUNK)))
        .all();
      for (const row of rows) {
        try {
          const tracks: unknown = JSON.parse(row.tracks);
          if (!Array.isArray(tracks)) throw new TypeError('not an array');
          const maxAge = tracks.length ? TRACKS_MAX_AGE_MS : EMPTY_MAX_AGE_MS;
          if (now - row.probedAt <= maxAge) found.set(row.key, tracks as AudioTrack[]);
        } catch {
          this.db.orm.delete(audioProbe).where(eq(audioProbe.key, row.key)).run();
        }
      }
    }
    return found;
  }

  put(key: string, tracks: AudioTrack[], now = Date.now()): void {
    const values = { tracks: JSON.stringify(tracks), probedAt: now };
    this.db.orm
      .insert(audioProbe)
      .values({ key, ...values })
      .onConflictDoUpdate({ target: audioProbe.key, set: values })
      .run();
    this.prune(now);
  }

  private prune(now: number): void {
    this.db.orm
      .delete(audioProbe)
      .where(lt(audioProbe.probedAt, now - TRACKS_MAX_AGE_MS))
      .run();
    const total = this.db.orm.select({ n: count() }).from(audioProbe).get()?.n ?? 0;
    const excess = total - MAX_ROWS;
    if (excess <= 0) return;
    const oldest = this.db.orm
      .select({ key: audioProbe.key })
      .from(audioProbe)
      .orderBy(asc(audioProbe.probedAt))
      .limit(excess)
      .all();
    this.db.orm
      .delete(audioProbe)
      .where(
        inArray(
          audioProbe.key,
          oldest.map((r) => r.key),
        ),
      )
      .run();
  }
}
