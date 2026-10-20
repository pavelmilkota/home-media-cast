# ADR-0002 — Controlling Kodi: JSON-RPC over WebSocket on localhost

- **Status:** proposed
- **Date:** 2026-10-19

## Decision

- Kodi **21.x Omega** (stable; v22 is in beta), JSON-RPC API v13.5. The version is checked at
  startup via `JSONRPC.Version`; an unsupported major API version shows up in `/health`.
- Transport — **WebSocket `ws://127.0.0.1:9090/jsonrpc`**: it carries both responses and
  notifications (`Player.OnPlay/OnPause/OnStop/OnAVStart`), so status does not need polling.
  `Player.GetProperties` is polled every 1–2 s only during playback, for the position.
- In Kodi **only** "Allow programs on this system to control Kodi" is enabled. Neither
  "…on other systems" nor the HTTP web server: 9090 does not listen on the LAN.
- The backend is the **only** client. The frontend never talks to Kodi and cannot send an
  arbitrary method: the backend API has a fixed list of commands
  (play/pause/seek/stop/volume/audio/subtitle), each validated by a DTO.
- Parameter schemas come from a live `JSONRPC.Introspect` and are recorded in a test Kodi
  emulator (a fake WebSocket server) that the integration tests run against.

## Rejected

- The HTTP transport on the LAN with Basic auth: no notifications, and the password travels
  in clear text.
- Kodi in Docker: against the brief, and GPU/HDMI/audio access adds complexity.
- mpv instead of Kodi: simpler to control (IPC), but no YouTube addon, UI or ecosystem. Kept
  as a fallback if Kodi proves unstable.
