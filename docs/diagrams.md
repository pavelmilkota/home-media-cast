# Architecture diagrams

Based on ADR-0001 (backend on the PC by the projector) and ADR-0003 (our own cast receiver).

## 1. Overall architecture

```mermaid
flowchart LR
  subgraph Clients["Controlling devices (LAN)"]
    AND["Android<br/>YouTube app · PWA"]
    IOS["iPhone<br/>YouTube app · PWA · Shortcut"]
    TAB["Linux tablet<br/>browser / PWA"]
  end

  subgraph MiniPC["PC by the projector (Linux)"]
    subgraph API["home-media-cast (Docker, network_mode: host)"]
      WEB["React PWA<br/>(served by api)"]
      CORE["NestJS modules:<br/>Auth · Playback · Kodi · Library · Health"]
      PROV["Providers:<br/>YouTube · TorBox · Stremio/AIOStreams · Metadata"]
      CAST["yt-cast-receiver<br/>DIAL + TV code"]
      DB[("SQLite")]
    end
    KODI["Kodi 21 (host)<br/>+ plugin.video.youtube"]
  end

  PROJ["Projector (HDMI)"]

  subgraph Home["your AIOStreams instance (self-hosted or hosted)"]
    NGX["reverse proxy (optional)"] --> AIO["aiostreams"]
  end

  subgraph Internet
    TB["TorBox API + CDN"]
    YT["YouTube"]
    META["Cinemeta / TMDB"]
  end

  AND & IOS & TAB -- "HTTP(S) + device token" --> CORE
  AND & IOS -- "Cast (DIAL/lounge)" --> CAST
  CORE --- PROV
  CORE --- DB
  CAST --> CORE
  CORE -- "JSON-RPC WS 127.0.0.1:9090" --> KODI
  KODI --> PROJ
  PROV -- "Basic auth" --> NGX
  PROV -- "Bearer (backend only)" --> TB
  PROV --> META
  KODI -- "streams" --> TB & YT
```

## 2. YouTube from a phone (scenario A — the Cast button)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant P as YouTube app (phone)
  participant L as YouTube lounge (Google servers)
  participant R as yt-cast-receiver (in backend)
  participant B as Playback/Kodi module
  participant K as Kodi + YouTube addon
  participant Y as YouTube (video)

  R->>L: long-lived outbound connection (screen/lounge)
  R-->>P: SSDP/DIAL on LAN: "homeMediaCast" in the cast menu<br/>(or TV-code pairing — no LAN needed)
  U->>P: Cast → "homeMediaCast", video X
  P->>L: play(X, pos)
  L->>R: play(X, pos) command
  R->>B: KodiYouTubePlayer.doPlay(X, pos)
  B->>B: PlaybackJob(kind=youtube)
  B->>K: Player.Open plugin://plugin.video.youtube/play/?video_id=X
  K->>Y: addon (the PC's own session) fetches the stream
  K-->>B: notification Player.OnAVStart
  B-->>R: notifyExternalStateChange(playing)
  R->>L: status
  L-->>P: phone shows the remote
  U->>P: pause / seek
  P->>L: pause / seek(t)
  L->>R: pause / seek(t)
  R->>B: doPause / doSeek
  B->>K: Player.PlayPause / Player.Seek
```

⚠️ Cast commands go **through YouTube's servers**, not directly from the phone over the LAN:
DIAL is only used for discovery and launch, and "Link with TV code" works with no shared
network at all (`yt-cast-receiver` README). Device tokens therefore **do not apply** to this
path — see the accepted exception in ADR-0007.

Scenario B (Share / pasted link) differs only at the start:
`PWA/Shortcut → POST /api/playback/youtube {url}` → parse `videoId` → the same `Player.Open` step.

## 3. A movie from the catalog → Kodi

⚠️ Partly planned. Today sources come from AIOStreams and play through the loopback relay
([security.md](security.md)); the separate TorBox provider branch is not built yet.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant W as PWA
  participant B as Backend
  participant M as MetadataProvider
  participant S as Stremio/AIOStreams provider
  participant T as TorBox provider
  participant K as Kodi

  U->>W: search "Dune"
  W->>B: GET /api/catalog/search?q=Dune
  B->>M: search → Title[] (imdb:tt…)
  U->>W: open the title → "Sources"
  W->>B: GET /api/titles/movie/tt…/streams
  B->>S: /api/v1/search?type=movie&id=tt…
  S-->>B: results → classified into StreamSource[]
  B-->>W: sources (no temporary URLs, no secrets)
  U->>W: pick a source
  W->>B: POST /api/playback/stream {optionId}
  alt kind = direct_url
    B->>B: URL check (SSRF rules)
  else kind = provider_ref / torrent
    B->>T: resolvePlayback → fresh CDN URL
  else kind = external_url / unsupported
    B-->>W: 422 + a clear reason
  end
  B->>K: Player.Open {file}
  K-->>B: OnAVStart / error
  B-->>W: job state (WS/SSE)
```

## 4. Refreshing a temporary TorBox link

⚠️ Planned design; the TorBox client and this retry are not built yet.

```mermaid
sequenceDiagram
  autonumber
  participant B as Playback
  participant T as TorBox provider
  participant API as TorBox API
  participant K as Kodi

  Note over B: The link is NEVER stored as an ID.<br/>(torrent_id, file_id) is stored.
  B->>T: resolvePlayback(torrent_id, file_id)
  T->>API: GET /torrents/requestdl (Bearer)
  alt success
    API-->>T: data = CDN URL (open ≥1 h to start)
    T-->>B: ResolvedPlayback{url, obtainedAt}
    B->>K: Player.Open {file: url}
  else BAD_TOKEN / AUTH_ERROR
    API-->>T: auth error
    T-->>B: ProviderAuthError → UI "check the TorBox key", no retry
  else 429 / 5xx
    T-->>B: retryable → backoff (respecting 300/min)
  end
  Note over K,B: Later: Kodi reports an error / OnStop before the end of the file
  K-->>B: Player.OnStop (position P < duration)
  B->>T: resolvePlayback(...) again (≤ N attempts)
  T->>API: GET /torrents/requestdl
  B->>K: Player.Open {file: new url, resume P}
```

## 5. Network and security boundaries

```mermaid
flowchart TB
  subgraph LAN["Home LAN 192.168.1.0/24 — trust boundary #1"]
    PH["Phones / tablet"]
    subgraph M["PC by the projector — ufw: from LAN only API and DIAL ports"]
      APIP["backend :API_PORT<br/>device token required"]
      DIAL["yt-cast-receiver<br/>DIAL/SSDP on LAN + outbound lounge"]
      subgraph LO["127.0.0.1 — boundary #2"]
        K9090["Kodi JSON-RPC :9090<br/>(no authentication)"]
      end
      SECRETS[".env: TorBox key,<br/>AIOStreams uuid/pass"]
    end
    subgraph HS["AIOStreams host (if self-hosted)"]
      N3000["reverse proxy<br/>allow the PC only"]
    end
  end
  INET["Internet: TorBox, YouTube, Cinemeta/TMDB"]
  LOUNGE["YouTube lounge<br/>(cast commands from any paired sender)"]
  TS["Tailnet (optional, ADR-0007): tailscale serve → HTTPS for the PWA<br/>funnel forbidden"]

  PH -->|"HTTP(S)"| APIP
  PH -->|SSDP multicast + HTTP| DIAL
  DIAL -->|outbound| LOUNGE
  LOUNGE -.->|"cast commands — no device token"| DIAL
  DIAL --> K9090
  APIP --> K9090
  APIP -->|configured hosts only| N3000
  APIP -->|configured hosts only| INET
  APIP -. reads .-> SECRETS
  TS -.-> APIP
  PH x--x K9090
```

The port table with exact values is in [networking.md](networking.md).

## 6. Browser playback and handoff

```mermaid
sequenceDiagram
  participant P as Phone / laptop (web)
  participant A as API
  participant R as Relay (loopback)
  participant F as ffmpeg
  participant K as Kodi

  P->>A: POST /api/browser-play {optionId, caps}
  A->>R: register link, preflight
  A->>F: spawn (relay URL only), copy or transcode to HLS in tmpfs
  A-->>P: session {id, run, adjacent, autoNext}
  P->>A: GET /api/media/:id/:run/index.m3u8 (the id is the capability)
  F->>R: read the file
  P->>A: segments; the player's progress every 5 s
  Note over P,A: first "playing" event = confirmStarted
  A->>K: tracker.end(), then Player.Stop (only if Kodi was playing)
  P->>A: ended → POST /next {caps}
  A->>A: findAdjacent (same release) → new session, old one ends
```

### Guests

```mermaid
sequenceDiagram
  participant G as New device (guest)
  participant A as API
  participant S as Active session
  participant K as Kodi

  G->>A: POST /api/guest {deviceName} (no token)
  A-->>G: limited token (guest)
  G->>A: browse, POST /api/browser-play (the TV keeps playing)
  A->>S: dead sessions of other devices end; live ones keep playing
  Note over A,K: a guest's confirm stops nothing; the TV starting leaves it running
  G->>A: control the TV → 403 guest_forbidden (the web asks to pair instead)
  G->>A: POST /api/pairing/complete (guest bearer + code from the TV)
  A-->>G: same device id, new paired token; the session keeps playing
```
