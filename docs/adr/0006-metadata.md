# ADR-0006 — Metadata: Cinemeta first, TMDB optional

- **Status:** accepted for Stage 4 (built with Cinemeta only, TMDB not built); ⚠️ Cinemeta's terms of use were not found
- **Date:** 2026-10-19

The catalog (Stage 4) is built on IMDb IDs — the common key of the whole Stremio and
AIOStreams ecosystem.

- **Cinemeta** through our own Stremio client: no key, and the IDs match what AIOStreams
  accepts. Downsides: neither ToS nor rate limits are public, and the service may change
  without notice.
- **TMDB** — a second `MetadataProvider` behind the same interface, if localization (Russian
  titles and descriptions) or stability is needed. Requires a key (backend only),
  attribution in the UI and compliance with its ToS — re-check in Stage 4.
- Metadata cache — SQLite with a TTL (around a day); posters are not stored, only URLs.

## Browsing and search-as-you-type (discover-tab)

- `GET /api/catalog/browse?type&list=popular|new|featured&genre&skip` reads Cinemeta's `top`,
  `year` and `imdbRating` catalogs (no "trending" list exists). For `new` the genre is a year
  (default: the current year). `genre` is checked against a fixed allow-list, never forwarded
  raw. `nextSkip` is `skip` plus the items returned; an empty page ends the list.
- Catalog URLs answer `307` to `cinemeta-catalogs.strem.io`; `fetch` follows it. ⚠️ unverified:
  the page size is not documented (about 50 seen).
- The Search tab searches 300 ms after typing stops (from 2 characters) and replaces the browse
  list with the results. Both use the client's in-memory cache; no rate limits are published.
