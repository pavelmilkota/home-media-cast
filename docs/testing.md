# Testing

## Automated

```bash
pnpm verify    # eslint + prettier, build, tsc, Vitest (api and web)
```

- **api**: unit tests plus integration tests that run the whole Nest app on a random port
  with an in-memory database and `FakeKodiServer` (WebSocket, validates method names and
  required params against the recorded Kodi 21.3 introspection). Covered: Kodi client
  (success, timeout, disconnect, reconnect, JSON-RPC errors, notifications), pairing, auth,
  SSRF, player endpoints, SSE, health, request-log redaction, OpenAPI, static web serving.
- **web**: Testing Library tests with a fake backend (stubbed `fetch`, controllable SSE
  stream): pairing, connection state, remote controls, play-a-link, devices, routing.
  `renderApp({ url })` (`testing/render.tsx`) mounts the real route tree on a memory history;
  use it for anything that navigates, and `renderWithClient` for router-free components.
- Key tests were mutation-checked (break the code, see the test fail), e.g. revocation,
  attempt limit, status publishing, failed-start detection, send-on-release sliders.
- CI (GitHub Actions, `.github/workflows/ci.yml`) runs `pnpm verify` and a Docker build on every
  pull request and on pushes to `main`; CodeQL and dependency review run alongside it.

## Source list cache

- ✅ automated: store (round trip, retention, row cap, corrupt row, migration from 0001), service
  with an injected clock (debounce, forced refresh, in-flight sharing, failed update keeps the
  list, id stability and re-mint, live `findMatching`), e2e (warm hit, restart on the same DB
  file, no link or key in any response, clear), picker (updating line, polling swap, Retry with
  `refresh=1`), Settings card.
- ⚠️ unverified by hand: the real AIOStreams (second open instant after an API restart,
  `refreshing` true then false; AIOStreams stopped shows the cached list with `refreshError`),
  the phone (instant list, update lands without breaking taps, tapping during an update plays),
  and Settings → Clear cache followed by one slow open.

## Play history (change `playback-history-widget`)

- ✅ automated: store (24 h boundary, cap of 5, refresh of the same video, ordering), e2e (record
  an episode and a movie, replay with a fresh relay URL, 404, unmatched release, AIOStreams not
  configured, no provider URL, key or `releaseKey` in responses or request logs, auth),
  the route list in `openapi.e2e.spec.ts`, and the popover (hidden when empty, entries, replay
  closes, failure toast keeps the entry).
- ⚠️ unverified by hand: replay of a cached and of a no-longer-cached release against the real
  Kodi / AIOStreams / TorBox, entries surviving an API restart, and the button and popover on a
  phone (no overlap with the mini player, light and dark themes, closing on outside tap and Escape).

## Acceptance checks: core remote (status on 2026-10-19)

The test machine is a Dell Precision 7510 with Kodi 21.3. "Real Kodi" means the Flatpak Kodi
on that machine, not the fake.

| # | Feature | Status |
|---|---|---|
| 1 | Backend health | ✅ automated; real Kodi; container |
| 2 | PWA from phone/tablet | ⚠️ partly: Chrome on the test machine ✅ (pairing, remote, play); **Android ✅ reported by the maintainer: reachable and paired** (which controls were tried is not recorded); iPhone and tablet **unverified** |
| 3 | Kodi unavailable | ✅ with the fake (503, backend alive, `/health` degraded); real Kodi restart verified for `/health` (ok → reconnecting → unreachable → ok); ⚠️ "press play with Kodi stopped" not run on real Kodi |
| 4 | Direct link | ✅ real Kodi, via API and via the PWA in Chrome |
| 5 | Remote | ✅ real Kodi: pause, resume, seek, stop, volume; live state over SSE in Chrome without polling |
| 6 | Retry after error | ✅ real Kodi at API level (a bad link is accepted, then stops silently; the next link plays); the PWA's "did not start" message is tested with the fake only |
| 7 | No token | ✅ automated, every route; Kodi receives nothing |
| 8 | SSRF, pasted URL | ✅ automated (the four listed inputs plus ~40 more); ⚠️ redirects and DNS rebinding not closed; ⚠️ not repeated against real Kodi |
| 9 | Audio/subtitles | ⚠️ API and UI against the fake only; real multi-track file **unverified** |
| 10 | Code quality | ✅ `pnpm verify` green locally and in CI |

## Not tested yet

- iPhone and tablet (Android: paired and reachable, per the maintainer; a full control run is not recorded).
- Audio and subtitle switching on a real multi-track file.
- ufw rules (need sudo; see [networking.md](networking.md)).
- 4K HEVC 10-bit CPU load on the test machine (for information only, not pass/fail), and which GPU
  drives HDMI plus the projector's modes (needs the projector connected).
- Autostart and power-loss recovery (not built yet).

## Guests and the redesigned player (change `guest-browser-playback`)

Automated (`pnpm verify`):

- API (since `fix/browser-player-parallel`): the busy rule is gone; `guest-session`,
  `browser-play`, `external` and `handoff` e2e specs cover plays alongside each other and the TV,
  a converted play ending another converted one, "Send to TV" and "Continue here" with two
  devices playing, and a seek reusing the run's relay link (a fresh one when it cannot be read).
- API: `auth/guest.e2e.spec.ts` walks the whole route list with a guest token (anything outside
  the pinned allowed list answers 403 and sends nothing to Kodi) and with a paired token (every
  route reachable), and covers the registration limit, pairing with a guest bearer (same id, new
  token, old token dead) and `GUEST_PLAYBACK_ENABLED=false`. `auth/device.service.spec.ts` covers
  pruning, the cap, promotion and the `0009` migration. `browser-play/guest-session.e2e.spec.ts`
  covers a guest next to the TV, the busy rule (browser and external, paused 4 minutes, silent 5),
  the paired takeover without a gap in `BrowserStatus`, no writes, and promotion mid-play.
- Web: the bootstrap (registers, retry, `guest_disabled`, one registration after a 401), the TV
  gate on each surface with Kodi up and down, no queue/cache/device requests from a guest, pairing
  from the player (session and `?sheet=player` kept, a wrong code leaves the guest alone),
  effective target, local progress, the seek collector, auto-hide, and the player's structure.

⚠️ unverified by hand (Manual Testing Steps in the change's plan): everything on iPhone, Android
and a laptop, including the notch and home bar, fullscreen with the menu and sheets, quick seek
taps feeling immediate, and next-episode autoplay on phones. Whether the debrid plan allows two
streams at once, and how a guest's conversion affects Kodi on the Dell (and on the NUC after the
move), have not been measured.

## Browser playback and handoff (change `browser-playback-handoff`)

Automated (`pnpm verify`): `ffmpeg` argument builder, `playback-mode` tables, backpressure with a
fake process and clock, video facts on generated MKV/MP4 bytes, the session coordinator, handoff,
external-session position estimates, `externalPlayerLink`, and e2e tests for every route (auth,
ownership, no provider URL, key, release key or session id in responses and logs, revocation).
Series: `apps/api/src/browser-play/series.e2e.spec.ts` covers next and previous from the same
release, no match, `AUTO_NEXT_EPISODE=false`, and replay from Recent with and without a release
key; the TV's next-episode tests are unchanged. Tests that need a real `ffmpeg` (generated `lavfi`
clips, WebVTT) run in the container and are skipped, with a message, where it is absent.

⚠️ unverified by hand (Manual Testing Steps in the change's plan): playing, seeking, audio and
subtitle switching on an iPhone, an Android phone and a laptop; 1080p HEVC 10-bit conversion and
its speed and CPU on the target host; HDR looking right; "Continue here" / "Send to TV" against a real
Kodi, including in the last 10% of an episode; 4K handed to a laptop; pausing 15 minutes; locking the
phone; YouTube casting during a browser play; revoking a device and restarting the API while
playing (no `ffmpeg` left); open-in-player links on each platform.

Tried by hand in Chrome on the Dell (a 720p copy source, as a guest): ±10 s inside the run is
instant and exact; a seek outside it pauses the old picture and took 3.9 s (was 5–10 s, the old
picture playing on and then jumping). About 8 minutes of steady play with a 110 s pause showed no
jumps. ⚠️ unverified: the random jumps during playback reported on another session were not
reproduced. A slider seek froze in Firefox (Firefox applies the empty edit in `init.mp4`, see
ADR-0009); after the fix a seek to 13 min buffers from 0 and plays in Chrome. ⚠️ unverified: the
same seek in Firefox. Open spike questions
(`low_power`, `hvc1`, `EXT-X-START` on Safari, iPhone fullscreen) are in the spike notes.
