import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** A paired phone, tablet or browser. Only the SHA-256 of its token is stored. */
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
});

/** A title the household has liked, saved or watched. Shared by all paired devices. */
export const titles = sqliteTable('titles', {
  /** IMDb id. */
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  year: text('year'),
  poster: text('poster'),
  liked: integer('liked', { mode: 'boolean' }).notNull().default(false),
  saved: integer('saved', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

/** Watch progress per movie or episode (`tt…` or `tt…:season:episode`). */
export const progress = sqliteTable('progress', {
  videoId: text('video_id').primaryKey(),
  titleId: text('title_id')
    .notNull()
    .references(() => titles.id, { onDelete: 'cascade' }),
  season: integer('season'),
  episode: integer('episode'),
  /** Episode name, kept so history reads well without asking the metadata provider. */
  label: text('label'),
  positionMs: integer('position_ms').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  watched: integer('watched', { mode: 'boolean' }).notNull().default(false),
  lastPlayedAt: integer('last_played_at').notNull(),
});

/**
 * The release last started for a movie or an episode (JSON; holds the torrent info hash), so the
 * source list can flag it as last selected. Written when a play starts, whether or not enough was
 * watched to save progress. Host only: never returned by the API (AGENTS.md secrets rule).
 */
export const lastSource = sqliteTable('last_source', {
  videoId: text('video_id').primaryKey(),
  releaseKey: text('release_key').notNull(),
  playedAt: integer('played_at').notNull(),
});

/** The last raw AIOStreams answer for a title (`<type>:<id>`); a cache, safe to delete. */
export const streamCache = sqliteTable('stream_cache', {
  key: text('key').primaryKey(),
  /** JSON array. Holds provider links, so it must never leave the host (AGENTS.md secrets rule). */
  results: text('results').notNull(),
  /** JSON string[]. */
  errors: text('errors').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

/**
 * The audio tracks read from a file's own header, per `audioKey` (a hash of the torrent, file
 * and name; no link). An empty list means the file was looked at and nothing usable was found.
 * A cache, safe to delete.
 */
export const audioProbe = sqliteTable('audio_probe', {
  key: text('key').primaryKey(),
  /** JSON AudioTrack[]. */
  tracks: text('tracks').notNull(),
  probedAt: integer('probed_at').notNull(),
});

/** Small household-wide settings as JSON values, e.g. the audio and subtitle language last chosen. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON. */
  value: text('value').notNull(),
});
