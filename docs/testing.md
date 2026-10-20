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
- CI is not set up; where it runs is an open decision.

## Source list cache (change `streams-cache`)

- ✅ automated: store (round trip, retention, row cap, corrupt row, migration from 0001), service
  with an injected clock (debounce, forced refresh, in-flight sharing, failed update keeps the
  list, id stability and re-mint, live `findMatching`), e2e (warm hit, restart on the same DB
  file, no link or key in any response, clear), picker (updating line, polling swap, Retry with
  `refresh=1`), Settings card.
- ⚠️ unverified by hand: the real AIOStreams (second open instant after an API restart,
  `refreshing` true then false; AIOStreams stopped shows the cached list with `refreshError`),
  the phone (instant list, update lands without breaking taps, tapping during an update plays),
  and Settings → Clear cache followed by one slow open.

## Acceptance criteria, Stage 1 (status on 2026-10-19, Dell Precision 7510, Kodi 21.3)

"Real Kodi" means the Flatpak Kodi on the Dell, not the fake.

| # | Feature | Status |
|---|---|---|
| 1 | Backend health | ✅ automated; real Kodi; container |
| 2 | PWA from phone/tablet | ⚠️ partly: Chrome on the Dell ✅ (pairing, remote, play); **Android ✅ reported by the owner: reachable and paired** (which controls were tried is not recorded); iPhone and tablet **unverified** |
| 3 | Kodi unavailable | ✅ with the fake (503, backend alive, `/health` degraded); real Kodi restart verified for `/health` (ok → reconnecting → unreachable → ok); ⚠️ "press play with Kodi stopped" not run on real Kodi |
| 4 | Direct link | ✅ real Kodi, via API and via the PWA in Chrome |
| 5 | Remote | ✅ real Kodi: pause, resume, seek, stop, volume; live state over SSE in Chrome without polling |
| 6 | Retry after error | ✅ real Kodi at API level (a bad link is accepted, then stops silently; the next link plays); the PWA's "did not start" message is tested with the fake only |
| 7 | No token | ✅ automated, every route; Kodi receives nothing |
| 8 | SSRF, pasted URL | ✅ automated (the four listed inputs plus ~40 more); ⚠️ redirects and DNS rebinding not closed; ⚠️ not repeated against real Kodi |
| 9 | Audio/subtitles | ⚠️ API and UI against the fake only; real multi-track file **unverified** |
| 29 | Code quality | ✅ `pnpm verify` green locally; CI platform open |

## Not tested yet (Stage 1)

- iPhone and tablet (Android: paired and reachable, per the owner; a full control run is not recorded).
- Audio and subtitle switching on a real multi-track file.
- ufw rules (need sudo; see [networking.md](networking.md)).
- 4K HEVC 10-bit CPU load on the Dell (for information only, not pass/fail), and which GPU
  drives HDMI plus the projector's modes (needs the projector connected).
- Autostart and power-loss recovery (Stage 5).
