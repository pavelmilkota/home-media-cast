# ADR-0008 — Restarting Kodi from the PWA

- **Status:** proposed
- **Date:** 2026-10-20

## Decision

- The API container never starts or kills host processes. `POST /api/tv/restart-kodi` creates
  an **empty file** (`kodi-restart`) in a directory shared with the host and answers
  `202 {"status":"requested"}`. It never claims Kodi is back; the PWA shows the existing Kodi
  connection dot going red/amber and green again.
- A systemd **user** `.path` unit on the host watches that file and starts a oneshot service
  that runs `scripts/kodi-restart.sh`: delete the trigger, `flatpak kill tv.kodi.Kodi`, then
  start Kodi in its own transient unit (`systemd-run --user`), so Kodi is not a child of the
  oneshot service.
- At most one request per 30 s (429 after that). A request that cannot be written (directory
  missing or not writable) answers 503 and does not use up the 30 s.
- The trigger directory is a **separate bind mount** (`KODI_RESTART_DIR` → `/restart`), not
  the `data` volume. A named volume lives under root-owned `/var/lib/docker/volumes`, which a
  user unit cannot watch, and turning `data` into a bind mount would hide the existing database
  of installed copies. This differs from the plan, which wrote into `/data`.
- `GUI.SetFullscreen { fullscreen: "toggle" }` and `GUI.ActivateWindow { window: "home" }` are
  added to the fixed command list of ADR-0002 (`POST /api/tv/fullscreen`, `/api/tv/home`).

## Why not

- **Docker socket** in the container: it is root on the host.
- **`privileged` / extra capabilities / `pid: host`**: undoes `cap_drop: ALL` and
  `no-new-privileges` for a button.
- **Kodi's own `Application.Quit`**: it stops Kodi but cannot start it again.

## Consequences

- The caller sends no data that reaches the host: the file is empty and its name is fixed.
  Anyone with a device token can restart Kodi, like they can stop playback; the rate limit
  bounds repeated use.
- Without the host units installed, "Restart Kodi" still answers 202 and nothing happens.
  ⚠️ unverified: the host units have not been run on the real machine.
