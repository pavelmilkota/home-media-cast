# Installation (Linux, from scratch)

Verified on Linux Mint 22.2 (Dell Precision 7510) on 2026-10-19, except where marked ⚠️. Other
distributions should work; the steps only need Docker and Kodi.

## 1. Prerequisites

| Need | How | Checked |
|---|---|---|
| Docker + Compose v2 | `docker --version && docker compose version`; your user in the `docker` group | Docker 29.9.1, Compose v5.6.0 |
| Kodi 21 | `flatpak install flathub tv.kodi.Kodi` (apt only offers Kodi 20.5) | Flatpak 21.3 Omega |
| A DHCP reservation for the PC | router setting | ⚠️ not done |

Node and pnpm are **not** needed to run the app, only to develop it ([development.md](development.md)).

## 2. Kodi

Follow [kodi-setup.md](kodi-setup.md). Kodi must be running and its JSON-RPC must listen on
`127.0.0.1:9090`.

## 3. The app

```bash
git clone <repository> home-media-cast && cd home-media-cast
cp .env.example .env          # edit if needed; see environment.md
docker compose up -d --build  # first build downloads dependencies
docker compose ps             # wait for "healthy"
curl -s localhost:8787/api/health
```

Expected: `{"status":"ok","kodi":{"state":"connected","version":"13.5.0"},"db":"ok"}`.

The image is `home-media-cast:stage1` (base `node:24.18.0-bookworm-slim`). The container runs
as an unprivileged user with a read-only root file system; the SQLite file lives in the
`data` volume. Updating: `git pull && docker compose up -d --build`. Paired devices survive
because they are in the volume.

### GPU for browser playback

Playing in the browser may need `ffmpeg` to convert video; the image includes it. To let it use the
Intel GPU, set two values in `.env` (⚠️ checked only on the Dell Precision 7510 with the HD 530):

```bash
getent group render                          # the number after the second colon is RENDER_GID
ls -l /sys/class/drm/renderD*/device/driver  # find the Intel (i915) render node
```

```
RENDER_GID=<that number>
TRANSCODE_VAAPI_DEVICE=/dev/dri/<the Intel render node>
```

Compose passes that device and group into the container; `read_only`, `cap_drop: ALL` and
`no-new-privileges` stay. Without a GPU, remove the `devices` and `group_add` lines and set
`TRANSCODE=software` (heavy on the CPU) or `off`. All options are in [environment.md](environment.md).
Open the page from a phone, choose "This device" under "Play on" in the source picker and play a
cached source. ⚠️ unverified on the NUC (Intel J5005): repeat the speed check there first
([hardware.md](hardware.md)).

## 4. Choose an AIOStreams instance (optional)

Sources come from [AIOStreams](https://github.com/Viren070/AIOStreams); without it you can
still cast YouTube and play pasted links. The backend needs a base URL plus the uuid and password
of a user configuration, nothing else, so any instance works:

| | Self-hosted | Hosted (for example ElfHosted) |
|---|---|---|
| `AIOSTREAMS_URL` | your LAN, tailnet or domain address | the public HTTPS URL |
| `PLAYBACK_ALLOW_HOSTS` | add the instance host if its stream links are on a private address | not needed |
| Trade-off | full control, you keep it running | no upkeep, a third party sees your requests |

⚠️ unverified: the maintainers run a self-hosted instance. A hosted one should behave the same,
because the same documented `/api/v1/search` API is used, but it has not been tried.

## 5. Firewall

Allow the API port from the LAN only: see [networking.md](networking.md). Do this **before**
you rely on it; until then the port is reachable from anything that can route to the PC.

## 6. Open it on a phone, and pair it for the TV

Open `http://<PC address>:8787` on the phone. It registers itself as a guest and can browse and
play in the browser at once, with Kodi running or not. To control the TV, open **Settings → Pair
with the TV** (or tap any TV control), tap **Show code on TV**, type the 6-digit code that
appears on the projector, and name the device. Pairing needs Kodi. `GUEST_PLAYBACK_ENABLED=false`
makes every device pair first. ⚠️ Android, iPhone and tablet are not
tested yet ([testing.md](testing.md)).

## Open in VLC from Chrome on Linux (Linux Mint)

Chrome cannot start VLC by itself: VLC registers no link a web page may open. Two ways, both
⚠️ unverified on a real Mint machine:

- **One-time helper (one tap afterwards).** On the machine you browse from, with VLC and
  `python3` installed, run `scripts/linux/install-vlc-handler.sh` from this repository (`--remove`
  undoes it). It registers `hmc-vlc://` links for your user. The first "Open in player" makes
  Chrome ask to open it: allow, and tick "Always allow". The helper only opens this app's own
  `/api/media/` addresses.
- **No install.** "Open in player" also copies the stream link: paste it in VLC with Ctrl+N. Or tap
  "Download VLC playlist" and open the `.xspf` file (VLC owns that type; an `.m3u` goes to the
  default audio player instead).

## Open in a player on macOS

"Open in player" opens **IINA** (free, [iina.io](https://iina.io)), which registers `iina://` links
and plays the stream from the current position. VLC for macOS registers no link a web page may open,
so the stream link is also copied: paste it into VLC with Cmd+N, or tap "Download VLC playlist" and
open the `.xspf` file. ⚠️ unverified on a real Mac.

## Not covered yet

Starting Kodi and the container on boot (the test machine is also used for other work), HTTPS,
and installing the PWA to the home screen (ADR-0007).
