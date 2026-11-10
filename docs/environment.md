# Environment variables

Real values live only in `.env` on the host (git-ignored). `.env.example` is the template.
When you add a variable, add it to `.env.example` and to `compose.yaml` (which passes only
what the API reads, not the whole file).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | port of the API and the web UI |
| `KODI_WS_URL` | `ws://127.0.0.1:9090/jsonrpc` | Kodi JSON-RPC; **must be `ws://` on loopback** or the API refuses to start |
| `DB_PATH` | `./data/home-media-cast.sqlite` (container: `/data/...`) | SQLite file: paired devices, library, source list cache |
| `PLAYBACK_ALLOW_HOSTS` | empty | comma-separated hosts or IPs a pasted link may point to even if private (e.g. a self-hosted AIOStreams on the LAN) |
| `AIOSTREAMS_URL`, `AIOSTREAMS_UUID`, `AIOSTREAMS_PASSWORD` | empty | the AIOStreams instance and the user it is searched as; **all three or none** (none = the source list answers 503 "not configured"). The password stays in `.env` and is only sent as `Authorization: Basic` |
| `AUTO_NEXT_EPISODE` | `true` | when an episode played from the catalog ends (past 90 %), start the next one from the same release group (`bingeGroup`) if the instance has it cached; `false` turns it off |
| `GUEST_PLAYBACK_ENABLED` | `true` | a device with no token registers itself (`POST /api/guest`) and may browse and play in the browser or an external player, but cannot control the TV or change the library (ADR-0009). `false` closes the door: registration answers `403 guest_disabled`, existing guest tokens get `401`, and every device must pair. Guest rows stay in the database and work again if it is switched back on |
| `CINEMETA_URL` | public Cinemeta (`https://v3-cinemeta.strem.io`) | where title search and metadata come from. No key. Posters are loaded by the phone's browser straight from the CDN URLs Cinemeta returns. ⚠️ Cinemeta publishes no terms of use |
| `YOUTUBE_CAST_ENABLED` | `false` | initial state of the YouTube Cast receiver; a switch saved through `PUT /api/youtube/cast` (stored next to the DB in `youtube-cast.json`) wins |
| `YOUTUBE_DIAL_PORT` | `3100` | HTTP port of the DIAL server (not 3000, which a self-hosted AIOStreams often uses); UDP 1900 is fixed by SSDP. `scripts/ufw-setup.sh` calls it `DIAL_PORT` |
| `YOUTUBE_DEVICE_NAME` | `homeMediaCast` | name shown in the YouTube app's Cast menu |
| `KODI_RESTART_DIR` | `./restart` | host directory mounted into the container for the "Restart Kodi" button; the API creates `kodi-restart` in it and a systemd path unit on the host acts on it ([kodi-setup.md](kodi-setup.md#tv-buttons-and-restart-kodi-settings--tv)) |
| `KODI_LOG_PATH` | empty (compose sets `/kodi-log`) | directory with Kodi's `kodi.log`, read by the Logs page's Kodi tab. Compose mounts the host's `KODI_LOG_DIR` there read-only; without it the tab says the log is unavailable |
| `RENDER_GID` | none, **required by compose** | numeric GID of the host's `render` group (`getent group render`); lets the container's user open the GPU |
| `TRANSCODE_VAAPI_DEVICE` | `/dev/dri/renderD129` | the Intel GPU's render node, passed into the container. The Dell has two nodes: `renderD129` is i915 (Intel), `renderD128` is Nvidia. Check with `ls -l /sys/class/drm/renderD*/device/driver` |
| `TRANSCODE_TMPFS_SIZE` | `1g` | size of the container's `/tmp`, where HLS segments are written. It is RAM |
| `TRANSCODE` | `vaapi` | browser playback of video the browser cannot decode (at most 1080p, HDR tone mapped to SDR): `vaapi` encodes H.264 on the GPU, `software` uses `libx264 -preset veryfast` (heavy on the CPU), `off` never converts, so those sources show "TV only". A failing encoder gives an error; it does not switch by itself. ⚠️ unverified on real hardware |
| `TRANSCODE_HW_DECODE` | `false` | with `TRANSCODE=vaapi`, decode on the GPU as well. Leave off where the GPU cannot decode the source codec (the Dell's HD 530 has no HEVC 10-bit); the NUC J5005 should be able to. ⚠️ unverified |
| `BROWSER_AHEAD_SEGMENTS`, `BROWSER_BEHIND_SEGMENTS` | `12`, `6` | browser playback: how many 4-second segments `ffmpeg` may run in front of the player before it is paused, and how many are kept behind it. ⚠️ the defaults are guesses until the Phase 1 spike measures them |
| `WEB_DIST` | `apps/web/dist` | built web UI served by the API |

`TORBOX_API_KEY` is reserved for the planned TorBox client. Nothing reads it yet, and the
container does not receive it.
