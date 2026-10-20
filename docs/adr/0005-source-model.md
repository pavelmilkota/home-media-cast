# ADR-0005 — Content and source model

- **Status:** proposed
- **Date:** 2026-10-19

## Decision

Three **separate** entities, never mixed:

1. **Title** — metadata (movie/series/season/episode), keyed by `imdb:tt…` (plus optional
   `tmdb:…`). Source: a MetadataProvider.
2. **StreamSource** — *how* something can be played, a discriminated union:

   | `kind` | From | Strategy | MVP support |
   |---|---|---|---|
   | `direct_url` | Stremio `url`, pasted link | URL check (ADR-0007) → `Player.Open {file}`; `proxyHeaders` → Kodi syntax `url|Header=…` ⚠️ verify | yes |
   | `youtube` | Stremio `ytId`, YouTube link | `plugin://plugin.video.youtube/play/?video_id=` | yes |
   | `provider_ref` | TorBox (`torrent_id`+`file_id`), an AIOStreams result with a temporary link | `resolvePlayback()` right before start → `direct_url` | Stage 3 |
   | `torrent` | Stremio `infoHash`+`fileIdx` | **only** via TorBox and only on explicit user action: `checkcached` → (`createtorrent`) → `requestdl`. Without TorBox — a clear "no debrid provider" error | Stage 3 |
   | `external_url` | Stremio `externalUrl` | **never** sent to Kodi; shown as a link in the UI | yes (as a link) |
   | `unsupported` | `nzbUrl`, `*Urls` archives, rtmp, unknown | error naming the type | — |

3. **PlaybackJob** — `{ id, titleRef?, source (no secrets), state, resolvedAt?, attempts,
   lastError?: {code, message}, diagnostics }`. Stored in SQLite. Returned to the frontend
   **without** the resolved URL: temporary CDN links are seen only by the backend and Kodi.

**Provider-returned URLs ≠ user-pasted URLs.** A user URL goes through the strict SSRF rules
(ADR-0007). A provider URL is checked against that provider's host allowlist. If it carries
credentials (TorBox `token=`, an AIOStreams path with uuid/password — ⚠️ research.md §4), the
backend follows the redirect itself and gives Kodi only the final URL, without secrets.

> **Correction, 2026-10-19 (Stage 3 spike, verified on the owner's account):** for TorBox the
> final CDN URL (`https://<node>.tb-cdn.st/…?token=…`) carries **the account's API key as its
> `token`**. "Follow the redirect and give Kodi the final URL" therefore does **not** remove the
> secret for TorBox. Kodi must never receive a provider URL at all: it opens a loopback URL with
> an opaque id and the backend fetches the real one (see plan-stage3.md, relay). Not yet decided
> by the owner; ⚠️ the relay's behaviour with Kodi is unverified.

Temporary links are **never** identifiers. Retry after an error and continue-watching call
`resolvePlayback()` again; the position is restored by `Player.Open` with a resume
parameter (⚠️ exact parameter from Introspect).

## Cached source lists (change `streams-cache`)

The AIOStreams answer for a title is cached in SQLite and served stale-while-revalidate
(see [architecture.md](../architecture.md)). This does not change the model above: the cache
holds the provider's raw results on the host only, `StreamOption`s still never carry a URL,
and a fresh link is still requested right before playback. A cached `cached: true` flag can be
out of date, so the next / previous episode and queue picks (`findMatching`) always search live.
Tapping a source from a stale list is allowed; a dead link is reported by the relay preflight
as before.

## Provider contract — capabilities, not empty methods

```ts
interface Provider {
  id: string;
  capabilities: ReadonlySet<'search' | 'metadata' | 'streams' | 'resolve' | 'subtitles'>;
}
interface StreamsCapable  { getStreams(ref: TitleRef): Promise<StreamSource[]> }
interface ResolveCapable  { resolvePlayback(src: ProviderRef): Promise<ResolvedPlayback> }
// … Search/Metadata/Subtitles likewise; the registry checks the capability before calling.
```

## Open question for Stage 3

⚠️ unverified: after playing a URL, real Kodi 21.3 emitted `VideoLibrary.OnUpdate`, which
suggests it records played paths (for resume points and play counts) in its own video
database. If that stores the full URL, a TorBox link carrying a token would persist in
Kodi's DB, which conflicts with the "no secrets in any URL handed to Kodi" rule. Before
Stage 3: inspect `MyVideos*.db` after playing a URL with a query string, and decide
between stripping/short-lived links or disabling watched-state writes. In the Stage 1
manual run, `Player.GetItem` returned the URL with its query string removed, which is
reassuring for the API but says nothing about the database.
