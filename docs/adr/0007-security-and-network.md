# ADR-0007 — Security and network

- **Status:** proposed; the HTTPS question is **open** (Stage 2 spike)
- **Date:** 2026-10-19

## Decision

- **Device authentication:** pairing. A new device opens the PWA → the backend shows a
  6-digit code **on the projector** (`GUI.ShowNotification`) → the user enters the code →
  the device gets a long-lived random token (the DB stores only its hash); revocation in
  settings. Whoever sees the screen is in the room — Chromecast works the same way. CORS is
  not a security mechanism, only an addition.
- **As built (Stage 1, Phase 3):** the code is 6 digits, valid for 5 minutes, single use, and
  cancelled after 5 wrong guesses; `POST /api/pairing/start` has a 10 s cooldown and
  answers 503 (without creating a code) when Kodi cannot show it. Anyone on the LAN can ask
  for a code, so online guessing is bounded to about 5 guesses per 10 s against a
  1-in-a-million code, and every `start` pops a notification on the projector. A hardened
  option for later: require a physical confirmation on the PC.
- **Public routes** (no token): `GET /api/health` (state only, so the PWA can show
  connection status before pairing), `POST /api/pairing/start|complete`, and the Swagger UI
  at `/api/docs`, which describes the API but exposes no data. Every other route needs
  `Authorization: Bearer`.
- **SSE** (`GET /api/events`) is read with `fetch()` and an Authorization header. The browser
  `EventSource` cannot send headers, and a token in the URL would end up in logs.
- **The iOS Shortcut and the share target** use the same device token.
- **Accepted exception — YouTube casting.** Through `yt-cast-receiver`, playback can be
  controlled by anyone who sees the device via DIAL on the LAN or knows the current TV code
  (it changes every 5 minutes). Commands arrive through YouTube's servers and **do not check
  the device token**. A real Chromecast behaves the same way. The brief requires playback
  commands to be protected, so this is recorded as a deliberate exception. Its bounds:
  YouTube videos only, play/pause/seek/volume only, no access to settings, secrets or other
  providers. A "YouTube casting on/off" switch lives in settings.
- **Kodi 9090 — localhost only** (ADR-0002). Only the backend port and DIAL
  (yt-cast-receiver) face the network.
- **Firewall on the PC (ufw):** inbound from `192.168.1.0/24` — the backend port, the DIAL
  HTTP port and **UDP 1900** (SSDP); Kodi's 9090/8080 closed from outside. Outbound — HTTPS
  to the internet (YouTube lounge and video, TorBox, metadata) and `192.168.1.10:3000`
  (AIOStreams). Nothing is published to the internet; `tailscale funnel` is forbidden, as
  on the homeserver.
- **SSRF:** the backend itself only calls **configured** hosts (TorBox API, AIOStreams,
  Cinemeta/TMDB). A user `direct_url`: `http(s)` only; after DNS resolution, loopback,
  link-local, RFC1918 and CGNAT (`100.64/10` — the tailnet) are denied. Exceptions — an
  explicit allowlist in config. The backend does **not** download this URL — Kodi opens it,
  but Kodi is on the same machine, so the check is required even for "just pass it on".
  Residual risk — **DNS rebinding**: the backend checks the name, Kodi resolves it again and
  may get a different address. Mitigations: a short list of allowed schemes, rejecting IP
  literals from private ranges, and where possible handing Kodi a URL with the already
  checked IP (breaks TLS SNI — evaluate in Stage 1). The risk is not fully closed.
- **Residual risk — HTTP redirects** (found while implementing, Stage 1): a public URL can
  answer `302 Location: http://127.0.0.1:…` and Kodi follows redirects by itself, so the
  check on the pasted URL does not cover where Kodi ends up. Kodi would only issue a GET,
  and its JSON-RPC port speaks no HTTP GET side effects, but ⚠️ this is unverified against
  the LAN services. Closing it needs a redirect-resolving step in the backend (HEAD/GET with
  `redirect: 'manual'`, re-checking each hop) — not done in Stage 1.
- Provider URLs are checked separately — against the provider's host allowlist (ADR-0005).
- **Secrets:** env/`.env` on the PC only (`.env.example` in git). Logs are redacted by key
  list (`token`, `apikey`, `authorization`, `password`, `token=` query params), and CDN URLs
  are masked (host visible, path truncated). No TorBox permalinks with `token=` in Kodi.
- **HTTPS for the PWA — deferred to Stage 2; Stage 1 runs over HTTP on the LAN.** Updated
  2026-10-19 after talking to the owner (they leaned towards a separate Tailscale account,
  but would prefer a local certificate if it works without problems).

  **Key finding:** the Android share target requires the PWA to be installed as a
  **WebAPK**. A WebAPK is built by a Google server from the manifest data and icons that
  Chrome sends. A Chromium developer wrote that WebAPKs are not built for addresses not
  reachable from the internet; users report it does work on a private network.
  <https://groups.google.com/a/chromium.org/g/chromium-discuss/c/ebh9p7M7P5o>,
  <https://stackoverflow.com/questions/66336077/webapk-creation-failures-on-android-over-vpn>
  ⚠️ This applies **equally** to a local certificate and to `*.ts.net`: neither address is
  reachable from the internet. So Tailscale gives **no** share-target guarantee over a local
  certificate. Only a hands-on test on the Pixel decides it.

  Options, in order of preference:
  1. **Local CA**: our own CA with `nameConstraints` — it can sign **only** the PC's IP/name,
     so a leaked CA key cannot forge other sites. Plain mkcert does not add such a
     constraint. No proxy, no VPN. Cost: install the root certificate once on each device.
     On iOS — install the profile and manually enable "full trust". On Android — a user CA,
     which Chrome trusts; the system shows a "network may be monitored" warning. ⚠️ Verify
     both during the test.
  2. **Tailscale — in the existing tailnet, not a new account.** A separate account is a
     separate tailnet, and a phone is connected to one tailnet at a time: the Pixel would
     have to switch between the homeserver and this project. Instead: the PC tagged
     `tag:home-media-cast` (neither the SSH rule nor the wildcard grant to `tag:servers`
     applies to it); Vlada invited as a **member**, not an owner; a separate grant
     `member/owner → tag:home-media-cast: tcp:443`. ⚠️ Check the free plan's user limit.
     Cost: Tailscale must be on on the phones, even at home.
  3. Own domain + Let's Encrypt via DNS-01 — if a domain appears.
  4. No HTTPS: Android uses YouTube's Cast button (scenario A, no HTTPS needed) and pasted
     links; iPhone uses Shortcuts, which do not need HTTPS either.

  **Plan:** in Stage 2, a one-hour spike: CA (option 1) → install the PWA on the Pixel → does
  it appear in Share? If yes, keep option 1. If not, option 2 will not fix it (same WebAPK
  problem), and we stay on option 4.
