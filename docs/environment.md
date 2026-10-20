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
| `CINEMETA_URL` | public Cinemeta (`https://v3-cinemeta.strem.io`) | where title search and metadata come from. No key. Posters are loaded by the phone's browser straight from the CDN URLs Cinemeta returns. ⚠️ Cinemeta publishes no terms of use |
| `YOUTUBE_CAST_ENABLED` | `false` | initial state of the YouTube Cast receiver; a switch saved through `PUT /api/youtube/cast` (stored next to the DB in `youtube-cast.json`) wins |
| `YOUTUBE_DIAL_PORT` | `3100` | HTTP port of the DIAL server (not 3000, which a self-hosted AIOStreams often uses); UDP 1900 is fixed by SSDP. `scripts/ufw-setup.sh` calls it `DIAL_PORT` |
| `YOUTUBE_DEVICE_NAME` | `homeMediaCast` | name shown in the YouTube app's Cast menu |
| `KODI_RESTART_DIR` | `./restart` | host directory mounted into the container for the "Restart Kodi" button; the API creates `kodi-restart` in it and a systemd path unit on the host acts on it ([kodi-setup.md](kodi-setup.md#tv-buttons-and-restart-kodi-settings--tv)) |
| `WEB_DIST` | `apps/web/dist` | built web UI served by the API |

`TORBOX_API_KEY` is reserved for the planned TorBox client. Nothing reads it yet, and the
container does not receive it.
