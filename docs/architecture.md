# Architecture

Diagrams (Mermaid) and the reasoning are in
[`diagrams.md`](diagrams.md);
decisions are in [`adr/`](adr/).

## Overview

```
phone / tablet ──HTTP :8787──▶  API (NestJS) ──WebSocket 127.0.0.1:9090──▶ Kodi ──HDMI──▶ TV
   PWA (React)  ◀── SSE ──────  + built web UI                                       or projector
                                SQLite (paired devices, library, cache)
```

- `apps/api` — NestJS 12: `auth` (bearer guard, devices), `pairing`, `playback` (SSRF guard),
  `player` (commands, status, SSE), `kodi` (client, fixed command set, fake Kodi for tests),
  `db` (Drizzle + SQLite).
- `apps/web` — React 19 PWA (HeroUI). Bottom bar: Home, Search, Library. A mini-player above it
  appears while a video plays and opens the Remote as a bottom sheet. The gear in the header
  opens Settings (volume, TV buttons, paired devices). Search runs as you type (after a 300 ms
  pause) and, with an empty box, lists popular / new / featured titles with infinite scroll
  (`GET /api/catalog/browse`, ADR-0006). A pasted web link in Search offers "Play this link on TV". Light and dark follow the system setting.
  Navigation is TanStack Router (code-based, `apps/web/src/router.tsx`); every screen has a URL:
  `/` (Home), `/search?q=`, `/library`, `/title/:type/:id`. `?sheet=remote|settings` opens a
  sheet over the current page (opening pushes a history entry, so Back closes it; a Remote link
  with nothing playing is dropped with `replace`). Unknown paths and bad title params redirect
  to `/`. An unpaired device sees the pairing screen on any URL and keeps that URL. Deep links
  and reloads rely on the API serving `index.html` for unknown GET paths.
  ⚠️ unverified: the phone walk-through (reload, Back, deep link, sheets) has not been done by hand.
- `apps/api/src/tv` — `POST /api/tv/fullscreen|home|restart-kodi` (ADR-0008).
- `packages/shared` — types and Zod schemas used by both; the same schemas generate the
  OpenAPI request bodies.
- **Source list cache** (`apps/api/src/sources`). The raw AIOStreams
  answer for a title is kept in SQLite (`stream_cache`, key `<type>:<id>`, one row per movie or
  episode), so the source picker opens without waiting for a search. It is
  stale-while-revalidate: a cached list is returned at once and refreshed in the background
  (at most once per 15 s per title, or at once with `?refresh=1`); the response carries
  `fetchedAt`, `refreshing` and `refreshError`, and the picker polls every 2 s while
  `refreshing`. A cold title waits for the search, as before. If an update fails the cached list
  stays and `refreshError` says why. Retention: 30 days and at most 500 rows. Option ids are
  minted once per served list (and again after 20 min), and ids from a replaced list stay
  playable for their own 30 min. The rows hold the providers' links, which may embed a debrid
  key; they sit only in the host database (like the paired-device hashes), are never logged and
  are never returned by an endpoint: the frontend sees `StreamOption`s only. They are stored
  because the list is useless without the links, and a link is re-requested before playback
  anyway (ADR-0005). `findMatching` (next / previous episode, queue) deliberately bypasses the
  cache and always searches live, because it picks what plays unattended and a cached
  "cached" flag can be out of date. `GET /api/streams/cache` reports the size,
  `DELETE /api/streams/cache` clears it (Settings → Source cache).
  ⚠️ unverified: not yet tried by hand against the real AIOStreams or on a phone.
