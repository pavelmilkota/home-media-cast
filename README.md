# home-media-cast

**A do-it-yourself Chromecast: a small PC running Kodi, plugged into your TV or projector, and
controlled from any phone or tablet.**

Search for a title on your phone, pick a source, and it plays on the big screen. Cast from the
YouTube app the same way you would to a Chromecast, or paste a video link. The app talks only to
the services you configure; nothing else leaves your home network.

> **License:** [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, hobby, educational and
> other noncommercial use. This is *source-available*, not OSI "open source".
>
> **Status:** early. Several parts have only been tested against fakes; anything not yet tried
> by hand is marked ⚠️ in the docs.

## Why

- **Streaming sticks are closed.** A Chromecast is tied to a vendor account, can lose features
  when the vendor changes its plans, and runs only what the vendor allows.
- **Cheap sticks run out of memory.** A Chromecast HD, for example, has little RAM and stalls
  on high-bitrate or very large files. A small PC has the memory and hardware decoding to play
  them.
- **Stremio is a great catalog, but not a TV box.** It works well on a laptop or a phone. On
  the living-room screen that usually means an HDMI cable to a laptop, or a TV app that does
  not use the setup you configured.
- **Kodi is an excellent player** (hardware decoding, HDR, almost any codec), but its interface
  is built for a keyboard or a TV remote. Finding a film by name from your phone is not what it
  is good at.

## What it does

home-media-cast is a small backend and a web remote (a PWA). The backend is the only client of
Kodi, and Kodi itself is never reachable from the network.

- **Phone remote (PWA):** play, pause, seek, volume, subtitles and audio tracks, a queue, and a
  mini-player. Dark mode follows the system. English, Polish, Russian and Ukrainian.
- **Catalog:** search by title, browse popular titles, seasons and episodes, "my list", watched
  marks and "continue watching" with the resume position (metadata from Cinemeta).
- **Sources:** ask an [AIOStreams](https://github.com/Viren070/AIOStreams) instance for streams
  of a title, pick one, and play it. The stream link goes through a loopback relay, so Kodi
  never sees a provider URL or key.
- **YouTube:** cast from the YouTube app on Android (a built-in cast receiver), or paste a
  YouTube link.
- **Pasted links:** a direct video link plays once it passes an SSRF check (no local or private
  addresses).
- **Pairing:** to become a remote, a phone enters a 6-digit code shown on the TV, so only
  someone who can see the screen can pair.

## Built for AIOStreams, open to others

The source layer is built around [AIOStreams](https://github.com/Viren070/AIOStreams), an
aggregator for Stremio-compatible addons. It works with a **self-hosted** or a **hosted**
(for example ElfHosted) AIOStreams: the backend only needs a base URL, a user uuid and a
password ([installation](docs/installation.md#4-choose-an-aiostreams-instance-optional)).

Another stream aggregator can be plugged in behind the same source interface
(`apps/api/src/sources/stream-source.ts`, [ADR-0005](docs/adr/0005-source-model.md)). The rest of
the app (catalog, library, relay, remote) does not care which aggregator produced the list.

## Architecture

```
phone / tablet ──HTTP :8787──▶  API (NestJS) ──WebSocket 127.0.0.1:9090──▶ Kodi ──HDMI──▶ TV
   PWA (React)  ◀── SSE ──────  + built web UI                                       or projector
                                SQLite (paired devices, library, cache)
```

More in [docs/architecture.md](docs/architecture.md) and [docs/diagrams.md](docs/diagrams.md).

## Quick start

You need a PC with Kodi 21 and Docker. See [docs/installation.md](docs/installation.md) and
[docs/kodi-setup.md](docs/kodi-setup.md).

```bash
cp .env.example .env
docker compose up -d --build   # then open http://<this PC>:8787 on a phone
```

Open the API port to your LAN only ([docs/networking.md](docs/networking.md)). For hardware
advice see [docs/hardware.md](docs/hardware.md); for Home Assistant see
[docs/home-assistant.md](docs/home-assistant.md).

## Status

| Area | State |
|---|---|
| Kodi client, API, pairing, SSRF check, PWA remote, Docker Compose | built; running on one test machine; ⚠️ phone and tablet runs not finished |
| YouTube casting | works from an Android phone (confirmed in the logs); ⚠️ picture, sound and iPhone not verified |
| Catalog and library (Cinemeta) | built and tested against a *fake* Cinemeta; ⚠️ not yet tried against the real one |
| AIOStreams sources and relay | built and tested with a real Kodi and *fake* providers; ⚠️ real AIOStreams and TorBox only tried in throwaway prototypes |
| Retry with a fresh debrid link (TorBox client) | not built |

## Develop

```bash
npm i -g pnpm@12.14.0   # once
pnpm install
pnpm verify             # lint, build, typecheck, test
```

See [docs/development.md](docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Security
notes are in [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

## Legal

This project is only a remote control. It ships **no media, no addons and no indexers**. What
you play and which services you connect are up to you; follow your local law and the terms of
those services. It is not affiliated with or endorsed by Kodi, Stremio, AIOStreams,
ElfHosted, TorBox, Google or YouTube; Chromecast, Kodi and the other names belong to their owners.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Third-party licenses,
including two LGPL-3.0 packages used by YouTube casting, are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). For commercial use, contact the maintainer.
