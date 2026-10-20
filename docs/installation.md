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

## 6. Pair a phone

Open `http://<PC address>:8787` on the phone, tap **Show code on TV**, type the 6-digit code
that appears on the projector, and name the device. ⚠️ Android, iPhone and tablet are not
tested yet ([testing.md](testing.md)).

## Not done in Stage 1

Autostart of Kodi and of the container on boot (the Dell is a working machine), HTTPS and
installing the PWA to the home screen (Stage 2 spike, ADR-0007).
