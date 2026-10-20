#!/usr/bin/env node
// Imports seed/stremio-library.json (exported from web.stremio.com) into the SQLite library.
// Usage: node scripts/seed-library.mjs [--db data/home-media-cast.sqlite] [--seed seed/stremio-library.json]
// Idempotent: titles are upserted, `saved` is only ever switched on, and progress rows that
// already exist are left alone. Run it after the API has started once (it creates the schema).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { console } from 'node:console';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const dbPath = resolve(arg('db', 'data/home-media-cast.sqlite'));
const seed = JSON.parse(readFileSync(resolve(arg('seed', 'seed/stremio-library.json')), 'utf8'));

const Database = createRequire(resolve('apps/api/package.json'))('better-sqlite3');
const db = new Database(dbPath, { fileMustExist: true });
db.pragma('foreign_keys = ON');

// Same thresholds as LibraryService.
const WATCHED_AT = 0.9;
const MIN_POSITION_MS = 30_000;
// Stremio resets the offset to ~0 once an episode ends and keeps pointing at it.
const RESET_OFFSET_MS = 1_000;

const upsertTitle = db.prepare(`
  INSERT INTO titles (id, type, name, poster, liked, saved, updated_at)
  VALUES (@id, @type, @name, @poster, 0, @saved, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET saved = MAX(saved, excluded.saved)`);
const insertProgress = db.prepare(`
  INSERT OR IGNORE INTO progress
    (video_id, title_id, season, episode, label, position_ms, duration_ms, watched, last_played_at)
  VALUES (@videoId, @titleId, @season, @episode, NULL, @positionMs, @durationMs, @watched, @lastPlayedAt)`);

let titles = 0;
let rows = 0;
db.transaction(() => {
  for (const it of seed.items) {
    const lastPlayedAt = Date.parse(it.lastWatched);
    upsertTitle.run({
      id: it.id,
      type: it.type,
      name: it.name,
      poster: `https://images.metahub.space/poster/small/${it.id}/img`,
      saved: it.inLibrary ? 1 : 0,
      updatedAt: lastPlayedAt,
    });
    titles++;
    if (!it.videoId) continue;
    const share = it.durationMs > 0 ? it.positionMs / it.durationMs : 0;
    const finished =
      it.flaggedWatched ||
      share >= WATCHED_AT ||
      (it.timesWatched > 0 && it.positionMs <= RESET_OFFSET_MS && it.durationMs > 0);
    if (!finished && it.positionMs < MIN_POSITION_MS) continue;
    const [, season, episode] = it.videoId.split(':');
    const r = insertProgress.run({
      videoId: it.videoId,
      titleId: it.id,
      season: season ? Number(season) : null,
      episode: episode ? Number(episode) : null,
      positionMs: finished ? 0 : it.positionMs,
      durationMs: it.durationMs,
      watched: finished ? 1 : 0,
      lastPlayedAt,
    });
    rows += r.changes;
  }
})();
console.log(`titles upserted: ${titles}, progress rows added: ${rows}`);
db.close();
