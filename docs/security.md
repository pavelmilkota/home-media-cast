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
  `POST /api/pairing/*`, `POST /api/guest` and the OpenAPI UI at `/api/docs`. A request without a
  valid token never reaches Kodi.
- **Two kinds of token.** A *paired* token (the code shown on the projector) reaches every route.
  A *guest* token, which a device gets by calling `POST /api/guest` (10 registrations a minute
  for everyone, 200 guests kept), reaches only handlers marked `@GuestAllowed()`: reading the
  catalog, library, sources and play history, the status stream, and playing in the browser or an
  external player. Everything else answers `403 guest_forbidden`; a new route is closed to
  guests until someone opens it. `GUEST_PLAYBACK_ENABLED=false` switches guests off (ADR-0009).
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
- **Logs page.** `GET /api/logs/app` and `/api/logs/kodi` need a bearer token like the rest. Every
  line is redacted by the API before it leaves (and the app's entries before they are stored):
  sensitive query values and `key=value` pairs, `Bearer` tokens, URL credentials and relay ids.
  The app buffer keeps the last 1000 warnings and errors in memory only; the Kodi tab reads at
  most the last 256 KB of `kodi.log` (500 lines) through a read-only mount of the log
  *directory* (`KODI_LOG_DIR`), nothing else from Kodi's data. Redaction is pattern-based, so
  an unusual secret format in an addon's output could slip through. ⚠️ unverified on the real
  host.
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
- **Browser playback** (`/api/browser-play`, token required; `/api/media/:session/:run/:file`,
  public). The media route has no bearer because `<video>` cannot send one; the 128-bit session id
  in the path is the capability. It serves only an allowlist of file names from the current run of
  a live session, with `Cache-Control: no-store`, and `404` for everything else; the control
  routes answer `404` for another device's session. Revoking a device ends its session. `ffmpeg`
  reads the loopback relay (never a provider link), is started without a shell, with only `PATH`
  and a locale in its environment, `-protocol_whitelist http,tcp,file`, and its stderr is masked
  before logging. **Anyone on the LAN who holds the media URL can watch until the session ends.**
  See ADR-0009. ⚠️ unverified on real sources and devices.
- **External players** (`POST /api/browser-play/external`, token required;
  `GET|HEAD /api/media/:session/file/:name`, public). The file route serves the source's own bytes
  with `Range` through the relay, never the provider link, to whoever holds the session id (128
  bits, never logged; `redactUrl` masks it, also in `/api/browser-play/external/<id>`). **Anyone on
  the LAN who holds the URL can read the file until the session ends**, and a player may keep the
  URL in its history: the session ends after 30 minutes without a request, at most 12 hours in all,
  when the device is revoked, or when something else takes over, and ending it cuts the open
  stream. The relay's loopback-only `handle` is unchanged.
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
- **Anyone on the LAN can register as a guest and start a stream on the debrid account**,
  including an uncached source, which starts a download there. A guest cannot touch the TV or
  the library, but it spends the account. Revoking a device no longer locks it out: it
  registers again as a guest. `GUEST_PLAYBACK_ENABLED=false` is the way to close the door.
- ⚠️ Kodi's video database may keep played URLs (ADR-0005).
- **YouTube casting bypasses device tokens by design** (ADR-0007, accepted exception). Off by
  default (`YOUTUBE_CAST_ENABLED`); switch with `PUT /api/youtube/cast` (token required). What a
  sender can do is bounded in code: the player accepts only an 11-character video id (the
  `plugin://` URL is fixed in `KodiCommands.openYouTube`) and maps play, pause, resume, stop,
  seek and volume onto the existing fixed commands. The receiver's own debug log is discarded
  because it carries lounge tokens; its state file (`youtube-cast.json`, mode 600) lives with the DB.
