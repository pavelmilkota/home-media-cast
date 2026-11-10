# ADR-0009 — Playing in the browser

- **Status:** proposed
- **Date:** 2026-11-03

## Decision

- A browser plays a catalog source through a **session**. `POST /api/browser-play` (device token
  required) takes an option id and the device's decoding abilities, and the backend:
  1. gets a link through the loopback relay (the provider link never leaves the relay),
  2. runs `ffprobe` on the **relay URL** to learn the video and the audio and subtitle tracks,
  3. refuses with `409 browser_unsupported` if the device cannot decode the video as it is,
  4. runs `ffmpeg` on the relay URL: the video is **copied**, the audio is copied when it is AAC
     and converted to stereo AAC otherwise, and the result is **HLS with fMP4 segments** in
     `/tmp/hmc-media/<session>/<run>/` (a tmpfs in the container).
- Transcoding to H.264 is a later phase of the same plan. This ADR covers copy sessions and the
  network surface they add.
- `ffmpeg` is paced by the API: it is paused (`SIGSTOP`) when it is more than the "ahead" budget
  in front of the player and resumed (`SIGCONT`) when the player catches up; segments behind the
  player are deleted. Left alone it would fill RAM and pull the whole file from the debrid
  account in minutes.
- **A seek outside the run is a new run** with a new playlist. The player's time is the run's
  `startMs` plus the `<video>` time. A seek inside what the run already has (buffered, or ahead up
  to what `ffmpeg` has written) just moves `currentTime`: instant, no new run. The new run reads
  the old run's relay link; a fresh provider link is asked for only when it cannot be read (a seek
  measured 10 s, 5 s of it the provider link). The old picture is paused while the new run starts. The playlist is served through Node with `#EXT-X-START:TIME-OFFSET=0`, so
  players start at the beginning of the growing playlist and not at the live edge.
- A session keeps its **backend-only source** from the start. Option ids are good for about 30
  minutes, far less than a film, so a run that needs a fresh link takes it from the session. If the
  provider has dropped the link for good, the release key is used to find the same release in a
  new search; if that fails too, the seek fails with `stream_expired`/`stream_unreachable`.
- **One session per device.** Starting one ends that device's previous one; other devices' plays
  follow "Sessions alongside" below. A run nobody fetches from for 60 s is killed and a session nobody touches for 30
  minutes ends; the next seek of a session without a run starts a new one.
- **Media route:** `GET`/`HEAD /api/media/:session/:run/:file` is public (`@Public()`), because
  `<video>` and native HLS cannot send `Authorization` and ADR-0007 keeps the device token out of
  URLs. The protection is the session id: 128 random bits, valid only for the current run of an
  existing session, gone when the session ends. `:file` must match a short allowlist
  (`index.m3u8`, `init.mp4`, `seg<n>.m4s`, `sub<n>.vtt`), the answer is `no-store`, and anything
  else is `404`. The control routes (`seek`, `DELETE`) are authenticated and answer `404` for a
  session that belongs to another device. The route is left out of the OpenAPI document.
- **Revoking a device** ends its session at once. `redactUrl` and `redactLine` mask the session id
  in `/api/media/<id>` and `/api/browser-play/<id>`, like the relay id.

## `ffmpeg` and untrusted files

`ffmpeg` parses files from a remote server, which is the usual way a media tool is attacked. It is
limited like this:

- No shell. The environment is `PATH` and a locale only, so it cannot see `AIOSTREAMS_PASSWORD`
  or any other secret of the API.
- Arguments are the relay URL, integers and fixed strings. `-protocol_whitelist http,tcp,file`
  stops a playlist or container from making it open anything else. Output goes to the working
  directory under fixed names, so no path is passed.
- Its input is the **loopback relay**, which already applies the SSRF check to every redirect hop.
- Its standard error is read as untrusted text: every line goes through `redactLine` and the relay
  ids are masked before anything is logged.
- It runs as the container's unprivileged user, inside the same hardening as the API
  (`read_only`, `cap_drop: ALL`, `no-new-privileges`). Only the Intel render node is added
  (`devices:` and `group_add:` in `compose.yaml`), for VAAPI in the transcoding phase. A bug in
  `ffmpeg` therefore has the API's privileges and the GPU device, but no more.
- Only one `ffmpeg` runs at a time.

## Why not

- **A device token in the media URL:** it would end up in history, `Referer` and logs
  (ADR-0007). A session id dies with the session.
- **A cookie:** needs a login flow the app does not have, and native HLS on iOS does not always
  send it.
- **Letting `ffmpeg` fetch the provider link itself:** the key in the link would be in its
  process arguments and its log lines.
- **Serving the file by range request and letting the browser demux it:** browsers play almost
  no MKV, and about half of the catalog is MKV.

## Consequences

- **Anyone on the LAN who has the media URL can watch until the session ends.** HTTP only, as the
  rest of the app (docs/security.md). The URL is shown to the page only, never logged, and a new
  session or a revoked device ends the old one.
- The media route is a new LAN-facing surface that does not need a token. It serves only files
  that `ffmpeg` wrote for the current run of a live session.
- RAM: the segments live in a tmpfs. Its size (`TRANSCODE_TMPFS_SIZE`) and the ahead and behind
  budgets (`BROWSER_AHEAD_SEGMENTS`, `BROWSER_BEHIND_SEGMENTS`) must fit next to Kodi.
- ⚠️ unverified: the pipeline has run only against generated clips (in the container) and
  fakes. Real sources, real devices (Safari in particular) and a pause of ten minutes against a
  real provider are the Phase 1 spike's job (`context/changes/browser-playback-handoff/spike.md`).

## The web client

- The source picker has a per-device "Play on: TV / This device" switch (`hmc.playTarget`,
  default TV). With "This device" a tap starts a session and opens a full-screen player at
  `?sheet=player`; closing it, or Back, ends the session. The TV flow is untouched.
- The page measures what it can decode (`MediaSource.isTypeSupported`, `canPlayType`) and sends
  it with the start request. Rows whose probed video the device cannot decode show "TV only"
  and are disabled; the label and the backend refusal use one rule (`copyBlocker` in
  `packages/shared`). Unknown video facts stay playable.
- The player feeds the one `<video>` through `hls.js` (loaded on first use), or natively where
  the browser has HLS. A seek outside the run is a new run, so the film's time is the run's
  `startMs` plus `video.currentTime`. The centre row skips ±10 s, ±30 s and ±1 min; quick taps
  outside the run are collected into one seek, and the buttons stay live while a seek runs (more
  taps collect into the next one). A large centred loader shows a seek or a stall after 250 ms. A run that fails, or ends more than a minute before the film does, is
  restarted at the current position twice, then the player shows an error; the budget comes back
  only after a run has played 20 s, so a run that dies on its first segment cannot loop. Every
  failure is reported to the server log (`POST /browser-play/:id/error`); a decode failure of a
  copied stream switches the session to converting when `TRANSCODE` is not `off`.
- **One clock.** `ffmpeg` keeps the source's timestamps (`-copyts`) and starts every stream at the
  keyframe before the position asked for (`-noaccurate_seek`). Before, a copy run started at that
  keyframe while converted audio started at the position itself; the gap lived only in an MP4
  edit list, which browsers ignore, so the sound ran up to a keyframe interval ahead of the
  picture and subtitles drifted. The server reads where a run really starts from its first
  segment (the empty edit in `init.mp4` plus `tfdt`) and returns that as `startMs`; cues are in
  film time and looked up by the player's position.
- **The player's `init.mp4` has no edit lists.** With `-copyts` ffmpeg keeps `tfdt` at 0 and puts
  the run's film time in an empty edit. Chrome's Media Source ignores edit lists; Firefox applies
  the empty edit, so a run started at 13 min sat 13 min after `currentTime` 0: the picture froze
  while hls.js fetched the whole film (seen after every slider seek). The server reads the start
  from ffmpeg's `init.mp4` and serves a copy without `edts` (`init-play.mp4`, `withoutEditLists`),
  so `currentTime` 0 is the run's first sample in every browser. ffmpeg's own `use_editlist=0`
  is not used: it drops the film time altogether (measured with 5.1).
  Checked in Chrome (a seek to 13:13 buffers from 0 and plays) and with ffprobe on the cleaned
  segment. ⚠️ unverified in Firefox and Safari.
- **hls.js, not Chrome's own HLS.** Chrome (156 seen) answers `canPlayType` "maybe" for HLS, but
  its player cannot parse these fMP4 segments (`DEMUXER_ERROR_COULD_NOT_PARSE`, every run, copy
  or converted). The native player is used only on Safari and where there is no Media Source.
- **Subtitles are flushed per cue** (`-flush_packets 1` on each `sub<n>.vtt`). Without it they sat
  in ffmpeg's 32 KB buffer and stayed empty until the run ended, so no cue ever showed.
- A run being replaced (seek, track, episode) is not restarted on its 404s: the server deletes its
  files at once, and restarting on them used to cancel the new run and cascade.
- **Dropped connections.** A provider connection that ends early made `ffmpeg` end the run with
  exit code 0 at that point (the player stopped or jumped ahead). `ffmpeg` now reopens it from the
  byte where it stopped (`-reconnect 1`), and the relay continues a provider stream that drops or
  stalls for 20 s with a new `Range` request (3 times per response) before it gives up.
- Desktop keys: Space/K play or pause, arrows and J/L seek 10 s, F full screen, M mute; a double
  click toggles full screen. The overlay is sized by the small viewport (`h-svh`), like the tab
  bar, so a browser's bottom toolbar does not hide the seek bar.
- Position goes to the library every 5 s, on pause and on `pagehide` (`fetch` with `keepalive`,
  because `sendBeacon` cannot send `Authorization`). The next start resumes from it unless the
  resume switch is off.
- ⚠️ unverified on a real device: fullscreen on iPhone (the overlay is the full screen there,
  `playsInline`), the wake lock (needs HTTPS, so it does nothing today), and Safari's native HLS
  against a growing playlist.

## Conversion, tracks and handoff

- **One rule, in `packages/shared` (`playbackMode`).** A source is copied when the device decodes
  it, converted to H.264 when it cannot and the picture is at most 1080p, and otherwise
  unsupported ("TV only"). HDR is tone mapped to SDR when converted. The picker's label and the
  backend's refusal use the same function. `TRANSCODE=vaapi|software|off` chooses the encoder
  (GPU, `libx264 -preset veryfast`, or none); a failing encoder is reported, never swapped for
  another. With `off` only copyable sources play in the browser. ⚠️ unverified on real sources:
  the GPU-decode path (`TRANSCODE_HW_DECODE`) fails on the Dell's HD 530 and is meant for the NUC.
- **Tracks.** Audio is chosen by a new run at the same position. Text subtitles are written to
  `sub<n>.vtt` from the same read and drawn by the page itself (image subtitles are not offered).
  The remembered language lives in `TrackChoices` (settings table), shared by Kodi and the browser.
- **Sessions alongside.** A play on the device's own screen that is neither converted nor a
  handoff (a copy play in the browser, any external player), and any guest's play, runs alongside:
  its first `playing` stops nothing, and the TV starting something leaves it running unless it was
  sent to the TV. A handoff ("Continue here") takes over once its first `playing` event reaches the
  server: every other session ends and the TV is stopped, the tracker first, so a stop past 90%
  does not start the next episode. A converted play does the same to the TV and to the plays that
  are not alongside, so the host converts one stream at a time. The kind is fixed at the start: a
  copy play that falls back to converting stays alongside, and a guest's converted play is
  alongside too, so two conversions can run at once. "Send to TV" sends the sender's own play when
  it has one, else the one playing; "Continue here" takes another device's play. Tried by hand in
  Chrome with a second (curl) guest device in both orders: neither player was closed. ⚠️ unverified:
  two real players, external players and the TV alongside.
  `BrowserStatus` goes to every paired device without a media id, link or release key.
- **Handoff** reads the active session on the server (`/api/playback/handoff/here|tv`). It uses the
  playing option while it is listed, then a match of the same release key, and never "any
  release": without a key it answers `409 handoff_pick_source` and the old player keeps going.
- **External players** (`/api/browser-play/external`, `/api/media/:id/file/:name`). The player
  gets a LAN URL with the session id and reads the source through the relay, with `Range`. The
  session starts at the first sequential read, ends after 30 minutes without a request (12 hours
  at most) or when something else takes over, and ending it cuts the open response: the only way
  to stop an external player. The position is estimated from the bytes asked for and is marked
  approximate; it is saved to the library after 30 s of sequential reading. The relay's own
  `handle` stays loopback-only; `serve` is the same streaming without that check, used only behind
  the session id. Per platform: `intent:` for VLC on Android, `vlc-x-callback://` on iOS,
  `iina://` on macOS (VLC for macOS registers no link a page may open), and on Linux `hmc-vlc://`,
  served by a one-time helper (`scripts/linux`). On macOS and Linux the stream address is copied
  too and a VLC `.xspf` playlist is offered; elsewhere the address is copied. "Copy stream link"
  is always in the player's menu. ⚠️ unverified: the app links on real devices, and the position
  margin.

## Guests

Playing in the browser must not need Kodi or pairing, so a device with no token registers itself
as a guest (`POST /api/guest`) and gets a limited token. Pairing stays the way to control the TV
and to write to the household's library. `GUEST_PLAYBACK_ENABLED=false` switches guests off.

- **Routes.** Deny by default: a guest token reaches only handlers marked `@GuestAllowed()`;
  everything else answers `403 guest_forbidden`. Allowed: `GET catalog/search`, `discover`,
  `browse`, `:type/:id`, `library`; `GET titles/:type/:id/streams`, `streams/options/:id/audio`,
  `playback/history`; `GET events`; every route of `browser-play/*`; `POST playback/handoff/replay/:id`.
  The e2e route walk pins this list, so a new route stays closed until it is added on purpose.
- **Sessions.** Each session carries a `guest` flag, set from the authenticated device. A guest's
  confirmed play does not stop the TV or other sessions, and the TV starting something does not
  end it, unless a paired device sent it to the TV (`toTv` marks it). A guest is never refused
  because another device plays; both play. A guest's start ends the dead sessions of other devices
  (a browser player silent for 5 minutes, an external one unread for 60 s). A paired handoff takes
  over from a guest like from any other session.
- **No writes.** A guest's play leaves no progress, last source, history entry or remembered
  track. It gets no resume point from the server; the browser keeps its own and sends `startMs`.
  Pairing during playback promotes the same device row (new token, same id), so the session
  stays its own and starts saving progress from then on.
- **Consequences.** Anyone on the LAN can start a stream on the debrid account, **including an
  uncached source that starts a download there**. A guest cannot touch the TV or the library, but
  it spends the account. Revoking a device ends its stream, but it registers again as a guest on
  its next request, so revoking no longer locks a device out; `GUEST_PLAYBACK_ENABLED=false` is
  the way to close the door. ⚠️ unverified: whether the debrid plan allows two streams at once
  (any two devices playing alongside, or a device next to the TV).
