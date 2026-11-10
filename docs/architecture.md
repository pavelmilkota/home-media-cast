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

- `apps/api` — NestJS 12: `auth` (bearer guard, devices, guests: `POST /api/guest`, `@GuestAllowed()`), `pairing`, `playback` (SSRF guard),
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
  to `/`. A device with no token registers itself as a guest and goes on to the URL it opened; the
  pairing screen shows only when the server has guests switched off. Pairing is for TV control and
  for writing to the library, and opens as a sheet (never a route, so a film keeps playing). Deep links
  and reloads rely on the API serving `index.html` for unknown GET paths.
  ⚠️ unverified: the phone walk-through (reload, Back, deep link, sheets) has not been done by hand.
- `apps/api/src/tv` — `POST /api/tv/fullscreen|home|restart-kodi` (ADR-0008).
- `apps/api/src/logs` — `GET /api/logs/app|kodi` for the web `/logs` page: a bounded buffer of the
  API's warnings and errors (Nest logger subclass installed in `main.ts`) and a tail reader for
  `kodi.log`, both redacted line by line (`redactLine`).
- `packages/shared` — types and Zod schemas used by both; the same schemas generate the
  OpenAPI request bodies.
- **Verified audio** (`apps/api/src/sources/audio-probe.ts`, `GET /api/streams/options/:id/audio`).
  The languages in the source list come from AIOStreams, which guesses them from the release
  name. The picker therefore asks for the file's real audio tracks, but only for the rows on
  screen (an `IntersectionObserver` with a 300 ms pause, so a fast scroll asks for nothing); until
  the answer arrives the row shows the release's languages and a "Checking audio…" chip, and a
  verified row shows `✓ <languages>`. The backend reads the start of the file through ranged
  requests (`RelayService.readRange`: same URL check and redirect handling as playback, at most 12
  requests and 6 MiB per file, 12 s, two files at once) and parses the Matroska `Tracks` element or
  the MP4 `moov` box; the file is never downloaded. It is only done for `direct_url` sources that
  are keyed (they name their torrent, or else give a file name and size, as Real-Debrid results do) and have `cached === true` (an unknown flag counts as not cached; the age of
  the list the flag came from is not checked), checked again right before the first request,
  because opening the link of an uncached torrent could start a download on the debrid account
  (the picker asks for confirmation before playing one). Languages already stored for a file are
  shown on any row, since reading them opens nothing. ⚠️ unverified against real TorBox. Answers are kept in SQLite (`audio_probe`, keyed by a hash of the info hash, file index,
  file name and size (service, name and size when there is no info hash), never by the link or the option id): 180 days, or 7 days when nothing usable
  was found, at most 5000 rows. A provider error is only remembered for 2 minutes. Later lists
  carry the verified languages (`audioVerified`) at once. They are applied to the response only,
  not to the stored result, so the release key used for "same release" matching does not change.
  The language filters keep using the list's languages: a row that was just verified does not
  appear or disappear under an active filter until the list is loaded again. A file whose tracks
  have no language set keeps the release's languages. AVI, TS and other containers are not read.
  ⚠️ unverified against real TorBox links: covered by unit tests on generated MKV/MP4 bytes and an
  end-to-end test with a fake provider.
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
- **Play history** (`apps/api/src/sources/playback-history.store.ts`, change
  `playback-history-widget`). Every catalog play (picker, queue, next / previous, auto-advance,
  replay) is recorded in SQLite (`playback_history`, one row per movie or episode, keyed by
  `videoId`) after `streams.play` succeeds. Rows live 24 h and at most 5 are kept. A row holds the
  display fields (title, year, poster, episode label, release name, resolution, quality) and the
  `releaseKey`, which carries the torrent info hash and stays on the host: no link, `optionId`
  or key is stored or returned. Pasted URLs and YouTube are not recorded. `GET
  /api/playback/history` lists the entries newest first; `POST /api/playback/history/:id/play`
  finds the same release again through `findMatching` (cached `direct_url` only, so a fresh link
  as in ADR-0005) and plays it; an unknown or expired id is 404, no matching source maps to
  `no_matching_source`. The web shows a "Recent" button beside the tab bar (hidden when the list
  is empty) that opens a popover of the entries. ⚠️ unverified: replay against the real Kodi,
  AIOStreams and TorBox, and the layout on a phone, have not been tried by hand.
- **Browser playback and handoff** (`apps/api/src/browser-play`, change `browser-playback-handoff`,
  ADR-0009). The picker's "Play on" switch (`hmc.playTarget`, per device) sends a source to
  `POST /api/browser-play` instead of Kodi. The backend probes the file through the loopback
  relay, decides per device (`playback-mode`, shared with the picker's labels) to **copy** the video,
  **transcode** it to H.264 (at most 1080p, HDR tone mapped; `TRANSCODE=vaapi|software|off`), or
  refuse (`browser_unsupported`, shown as "TV only"), and runs one `ffmpeg` (no shell, minimal
  environment, relay URL only) that writes HLS fMP4 segments to the tmpfs `/tmp/hmc-media`. The
  player gets them from `GET /api/media/:id/:run/:file`, which is public but gated by the
  unguessable session ID, because `<video>` cannot send `Authorization`. A seek outside the run, an
  audio change or an idle restart is a new run, so player time is `run.startMs` +
  `video.currentTime`; a seek inside what the run has only moves `currentTime`. A new run reads
  the previous run's relay link and asks for a fresh one only if it cannot read it. `ffmpeg` is
  paused (`SIGSTOP`) when it is more than `BROWSER_AHEAD_SEGMENTS` in front of the player.
  The session keeps the backend-only source, so a run late in a film can fetch a fresh link
  after the option id has expired. Progress is posted every 5 s and goes to the library and
  history like the TV's. **Next / previous** (`POST /api/browser-play/:id/next|previous`) use the
  same release matching as the TV (`WatchPlayService.findAdjacent`, then `findMatching` with the
  release's `bingeGroup`); the session response carries `adjacent` and `autoNext`
  (`AUTO_NEXT_EPISODE`), and the player advances on `ended` on the same `<video>`. Replay from
  Recent follows the device's target: in the browser it needs a stored release key (otherwise
  `handoff_pick_source`), while the TV keeps its any-release behaviour.
  **Sessions alongside** (`session-coordinator.ts`): a play on a device's own screen that is not
  converted (a copy play in the browser, any external player) or a guest's runs alongside the TV
  and other devices and takes nothing over. A handoff ("Continue here") and a converted play take
  over after the first `playing` event: a handoff ends every other session, a converted play ends
  the TV and the plays that are not alongside. On the TV `tracker.end()` comes before `stop`, so a
  stop past 90% does not start the next episode. A Kodi transition to a new playback (including a
  pasted link or YouTube) ends the sessions that are not alongside, and the one sent to the TV. "Continue here" / "Send to TV" are `POST /api/playback/handoff/here|tv`.
  **Open in player** (`external-session.ts`) serves the file over `GET /api/media/:id/file/:name`
  with `Range` and reports an approximate position from the byte offset read. ⚠️ unverified on real
  devices, real sources and the NUC; see [testing.md](testing.md).
