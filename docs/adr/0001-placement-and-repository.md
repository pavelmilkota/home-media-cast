# ADR-0001 — Where the backend runs and where the code lives

- **Status:** **accepted** by the owner 2026-10-19 (backend on the PC by the projector,
  separate repository). Until the final PC exists, the Dell Precision 7510 plays its role —
  see [`../test-hardware.md`](../test-hardware.md)
- **Date:** 2026-10-19

## Context

Kodi runs on a separate PC by the projector (the owner's decision). The open question was
where to run the backend (NestJS) and the PWA, and where to keep the code. The owner leaned
towards the `/srv/homeserver` monorepo because it brings autostart and ready-made
infrastructure.

The important detail: that infrastructure — `apps/startup/start-up.sh`, nginx, backups, the
dashboard, `apps/updates` — runs **only on the homeserver**. The monorepo starts nothing on
the PC by the projector.

## Options

| | A. Backend on the **PC** next to Kodi | B. Backend on the **homeserver** in `home_network` |
|---|---|---|
| Kodi JSON-RPC (9090, no authentication) | `localhost` only — never on the network | must be open on the LAN for the homeserver |
| DIAL/SSDP for YouTube's Cast button | natural: a device with its own LAN IP | multicast does not cross the `home_network` bridge; `network_mode: host` breaks the nginx model in AGENTS.md |
| Homeserver freezes (ISSUES.md, 9 times) | YouTube and direct links keep working | the whole app is dead |
| SSRF blast radius | only the PC and the LAN | **every container** on the homeserver plus host trust via the gateway (see `apps/claude-agent-api/README.md`) |
| Access to AIOStreams | one `allow <PC IP>;` line in nginx | by container name |
| Autostart, backups, updates | its own: systemd + compose `restart`, SQLite backup over the network to the homeserver | ready-made |
| Analogy with Chromecast | a self-contained device | a thin player depending on a server |

## Decision

**A — backend and PWA on the PC by the projector**, in Docker Compose with
`network_mode: host` (for SSDP and `localhost:9090`). Kodi runs on the host.

**Code:** a separate `home-media-cast` repository in Forgejo (pnpm workspace: `apps/api`,
`apps/web`, `packages/shared`, `docs/`, `docs/adr/`), with its own lockfiles, tests and CI.
The homeserver monorepo gets only **`apps/home-media-cast/`**, modelled on
`apps/home-tablet/`: a README about the device (IP, role, how to recover it) and a link to
the product repo, plus targeted homeserver changes: an `allow` for the PC in the aiostreams
nginx block, and optionally a backup target.

Why not everything in the monorepo:

- `start-up.sh` and the hard rules (nginx `server {}`, `home_network`) apply to *that* host.
  Code that runs on another host does not inherit them; it would have to work around them.
- The product needs its own CI (lint/typecheck/test/build) and versioning. The monorepo is
  infrastructure, with no build ("There is no build system").
- GitHub is a downstream mirror of Forgejo. The new repo fits the same scheme.

## Consequences

- The PC needs its own installation (`docs/installation.md` in the product), systemd or
  compose autostart, and Tailscale if it is chosen for PWA HTTPS (ADR-0007).
- Backups: the SQLite file and config are copied to the homeserver (e.g. via the same restic
  set). Details in Stage 5.
