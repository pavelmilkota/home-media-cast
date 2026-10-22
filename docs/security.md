# Security

Decisions are in [ADR-0002](adr/0002-kodi-control-plane.md) and
[ADR-0007](adr/0007-security-and-network.md). This page states what is implemented.

## Implemented

Tested automatically; anything not yet tried by hand is marked ⚠️.

- **Device pairing.** A 6-digit code is shown only on the projector (a Kodi notification).
  It is valid for 5 minutes, single use, and cancelled after 5 wrong guesses;
  `POST /api/pairing/start` has a 10 s cooldown and answers 503 without creating a code when
  Kodi cannot show it. The code is never in an HTTP response.
- **Tokens.** 256 random bits, shown once; the database stores only the SHA-256. Revoking a
  device takes effect on its next request.
- **Every route needs `Authorization: Bearer`** except `GET /api/health`,
  `POST /api/pairing/*` and the OpenAPI UI at `/api/docs`. A request without a valid token
  never reaches Kodi.
- **SSRF check on pasted links.** `http(s)` only, no embedded credentials, no `|`, and the
  host is resolved: loopback, RFC1918, link-local, CGNAT (the tailnet), multicast, reserved
  and non-global IPv6 are refused (HTTP 422). IPv4-mapped IPv6 and decimal/hex/octal IP forms
  are covered. Hosts in `PLAYBACK_ALLOW_HOSTS` are exempt.
- **Kodi is loopback-only.** The backend refuses a `KODI_WS_URL` that is not `ws://` on
  loopback, and the frontend can only trigger a fixed set of commands.
- **TV controls.** `POST /api/tv/fullscreen|home` map to two fixed Kodi commands.
  `POST /api/tv/restart-kodi` only creates an empty file in a shared directory (one request per
  30 s, 429 after) for a host-side unit to act on; the container gets no Docker socket and no
  extra privileges (ADR-0008). ⚠️ unverified on the real host.
- **Logs.** One line per request: method, redacted URL, status, time. Headers and bodies are
  never logged, so tokens, pairing codes and pasted links cannot appear.
- **Container.** Unprivileged user, read-only root file system, `cap_drop: ALL`,
  `no-new-privileges`, and only the variables the API reads (the TorBox key is not passed).
- **Dependencies.** Build scripts of `@scarf/scarf` (telemetry), `@swc/core` and `esbuild`
  are denied in `pnpm-workspace.yaml`; their binaries come as platform packages.
- **Stream lists** (`GET /api/titles/:type/:id/streams`, `POST /api/playback/stream`, token
  required). The title id is validated (`tt…`, `tmdb:…`, series `:season:episode`) before it
  reaches AIOStreams, whose uuid and password travel only in an `Authorization` header. A list
  contains titles, sizes, the service and a `cached` flag, never a URL, an info hash or a header;
  an option id is random and forgotten after 30 minutes (410). An uncached source can start a
  download on the debrid account, so the PWA asks for a second tap before playing one. AIOStreams
  being down or refusing the credentials is a plain 503 "not available" for the phone; everything
  else keeps working.
- **Loopback relay** (`/api/relay/:id`). A provider URL can carry a key (a TorBox
  CDN link's `token` *is* the account key, verified), so Kodi is never given one: it opens
  `http://127.0.0.1:<port>/api/relay/<opaque id>` and the backend fetches the real URL. The
  route needs no bearer (Kodi cannot send one) and instead answers only connections from
  loopback with a loopback `Host` header, for `GET`/`HEAD`, and only for a random 128-bit id
  with a time limit. Every redirect hop goes through the URL check again; custom headers go to
  the first host only; the provider URL is never logged or returned, and the id is masked in
  request logs. ⚠️ unverified: throughput on a real 4K file and a real provider link.
  The audio probe opens a provider link only for sources marked cached, because opening an
  uncached link could start a download on the debrid account. ⚠️ unverified against real TorBox.
- **YouTube links** (`POST /api/playback/youtube`, token required). Only an exact YouTube host
  is accepted (`youtube.com`, `m.`/`www.`/`music.` subdomains, `youtube-nocookie.com`,
  `youtu.be`), no port, no credentials. The backend keeps just the 11-character video id and a
  start offset; the link itself never reaches Kodi, so it needs no SSRF check. `list=` is parsed
  and ignored. The same parser (`packages/shared/src/youtube.ts`) runs in the PWA and the API.

## Known gaps

- ⚠️ **HTTP redirects and DNS rebinding.** Kodi resolves names and follows redirects itself,
  so a public URL can lead it to a local address. Not closed (ADR-0007).
- **HTTP only on the LAN.** The token travels in clear text on the home network until HTTPS
  is set up (planned, ADR-0007).
- **Anyone on the LAN can request a pairing code** (it pops up on the projector). Guessing is
  bounded to about 5 tries per 10 s against a 1-in-a-million code.
- ⚠️ Kodi's video database may keep played URLs (ADR-0005).
- **YouTube casting bypasses device tokens by design** (ADR-0007, accepted exception). Off by
  default (`YOUTUBE_CAST_ENABLED`); switch with `PUT /api/youtube/cast` (token required). What a
  sender can do is bounded in code: the player accepts only an 11-character video id (the
  `plugin://` URL is fixed in `KodiCommands.openYouTube`) and maps play, pause, resume, stop,
  seek and volume onto the existing fixed commands. The receiver's own debug log is discarded
  because it carries lounge tokens; its state file (`youtube-cast.json`, mode 600) lives with the DB.
