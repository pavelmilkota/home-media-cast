# home-media-cast

**A home-built replacement for a Chromecast: a small PC running Kodi, plugged into your TV or
projector, controlled from any phone or tablet.**

Open the web remote on a phone, search a title, pick a source, and it plays on the big screen.
Cast YouTube from the YouTube app as you would to a Chromecast. Paste a video link and play it.
Nothing leaves your home network except the requests to the services you choose to use.

> **License:** [PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, hobby, educational and
> other noncommercial use. This is *source-available*, not OSI "open source".
> **Status:** early. Several parts are tested only against fake devices; every unverified claim in
> the docs is marked ⚠️.

## The pain

- **Chromecast and similar sticks are closed.** They are tied to a vendor account, may stop
  working when the vendor changes course, and give you no control over what runs on them.
- **Stremio is a great catalog and source aggregator, but a poor TV box.** On a PC or a
  phone it is excellent. On a living-room screen you end up with a laptop and an HDMI cable, or
  a TV app that is not what you configured on your own server.
- **A Kodi box is the best player** (hardware decoding, HDR, every codec), but its remote and
  library UI are made for a keyboard or a couch remote, not for "find the film my friend
  mentioned" on a phone.

## What it does

home-media-cast is a small backend plus a PWA remote. It is the only thing that talks to Kodi, and
Kodi is never exposed to the network.

- **Phone remote (PWA):** play, pause, seek, volume, subtitles and audio tracks, a queue, and a
  mini-player. Dark mode follows the system. English, Polish, Russian and Ukrainian.
- **Catalog:** search by title, browse popular titles, seasons and episodes, "my list", watched
  marks and "continue watching" with the resume position (metadata from Cinemeta).
- **Sources:** ask an [AIOStreams](https://github.com/Viren070/AIOStreams) instance for streams
  of a title, pick one, and play it. The stream link goes through a loopback relay, so Kodi
  never sees a provider URL or key.
- **YouTube:** cast from the YouTube app on Android (a built-in cast receiver), or paste a
  YouTube link.
- **Pasted links:** a direct video link plays after an SSRF check.
- **Pairing:** a phone becomes a remote by typing a 6-digit code that appears on the TV, so
  only people in the room can control it.

## Designed for AIOStreams, adjustable to others

The source layer is built around [AIOStreams](https://github.com/Viren070/AIOStreams), an
aggregator for Stremio-compatible addons. It works with a **self-hosted** or a **hosted**
(for example ElfHosted) AIOStreams: the backend only needs a base URL, a user uuid and a
password ([installation](docs/installation.md#4-choose-an-aiostreams-instance-optional)).

Another torrent or stream aggregator can be added behind the same source interface
(`apps/api/src/sources/stream-source.ts`, [ADR-0005](docs/adr/0005-source-model.md)). The rest of the
app (catalog, library, relay, remote) does not depend on which aggregator produced the list.

## Architecture in one picture

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

Allow the API port from your LAN only ([docs/networking.md](docs/networking.md)). What hardware to
buy is in [docs/hardware.md](docs/hardware.md); Home Assistant is covered in
[docs/home-assistant.md](docs/home-assistant.md).

## Status

| Area | State |
|---|---|
| Kodi client, API, pairing, SSRF check, PWA remote, Docker Compose | built; deployed on one test machine; phone and tablet tests still open |
| YouTube casting | works from an Android phone (checked in logs); picture, sound and iPhone not yet verified |
| Catalog and library (Cinemeta) | built and tested against a *fake* Cinemeta; ⚠️ not yet tried against the real one |
| AIOStreams sources and relay | built and tested with a real Kodi and *fake* providers; ⚠️ real AIOStreams and TorBox probed only by spikes |
| Debrid retry with a fresh link (TorBox client) | not built |

## Seed the library from Stremio (optional)

`scripts/seed-library.mjs` imports an export of the Stremio web library and history into the
database. Put your export at `seed/stremio-library.json` (git-ignored); the shape is in
`seed/stremio-library.example.json`.

```bash
node scripts/seed-library.mjs   # --db / --seed override the defaults; safe to re-run
```

## Develop

```bash
npm i -g pnpm@12.14.0   # once
pnpm install
pnpm verify             # lint, build, typecheck, test
```

See [docs/development.md](docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Security
notes are in [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

## Legal

This project is a controller. It provides **no media, no addons and no indexers**. What you play
and which services you connect to are your responsibility; follow the law and the terms of those
services where you live. It is not affiliated with or endorsed by Kodi, Stremio, AIOStreams,
ElfHosted, TorBox, Google or YouTube; Chromecast, Kodi and the other names belong to their owners.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Third-party licenses,
including two LGPL-3.0 packages used by YouTube casting, are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). For commercial use, contact the maintainer.
