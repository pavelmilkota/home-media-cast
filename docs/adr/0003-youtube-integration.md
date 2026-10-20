# ADR-0003 — YouTube: our own cast receiver → the Kodi YouTube addon

- **Status:** proposed; **the key assumption is unverified** (see below)
- **Date:** 2026-10-19

## Decision

Three paths, in priority order:

1. **Scenario A — YouTube's Cast button.** `yt-cast-receiver` runs inside the backend: DIAL
   discovery plus "Link with TV code". Our `KodiYouTubePlayer extends Player` turns
   `doPlay(videoId, pos)` into `Player.Open` with
   `plugin://plugin.video.youtube/play/?video_id=<id>`, and `doPause`/`doSeek`/… into the
   matching Kodi JSON-RPC calls. Kodi's state goes back to the sender via
   `notifyExternalStateChange()`, so the phone stays the remote.
2. **Scenario B — Share.** Android: `share_target` of the installed PWA (needs HTTPS,
   ADR-0007). iOS: a Shortcut. Linux Mint: paste the link into the web UI. All three hit one
   endpoint, `POST /api/playback/youtube`, which extracts `videoId` (and `t=`, `list=`) from
   the URL and plays it through the same `plugin://` path.
3. **Fallback:** paste the link/ID manually. Works as long as the addon works.

Premium: **only** the Kodi YouTube addon's sign-in on the PC, which the user completes
themselves through the official OAuth device flow with their own Google Cloud OAuth client.
The backend does not see, store or proxy Google credentials; the phone's cookies are not
used. To revoke: myaccount.google.com → third-party apps, or sign out in the addon.

## Why

- TubeCast is Cast V1, last updated in 2022 → ❌ (research.md §1.1).
- `yt-cast-receiver` is alive, used by Volumio, and its `Player` extension point matches our
  task exactly.
- The anxdpanic addon is the actively maintained YouTube player for Kodi and supports OAuth
  sign-in.

## Unverified assumptions — must be resolved in Stage 2, before any claim of support

1. Current YouTube apps for Android and iOS see our DIAL receiver and/or accept a TV code.
2. The addon plays videos without ads (expected: it shows no ads at all).
3. What a Premium sign-in in the addon adds beyond that (Premium-only content, quality).
4. Whether the two YouTube clients (`youtubei.js` in the receiver and the addon in Kodi) fail
   together on the next YouTube change. This is the **main operational risk**: any YouTube
   change breaks one of two projects with independent release cycles.

## Consequences

- The backend needs `network_mode: host` (SSDP multicast) — consistent with ADR-0001 A.
- The `peer-dial` fork is licensed for non-commercial use only; acceptable at home, recorded
  in the product README.
