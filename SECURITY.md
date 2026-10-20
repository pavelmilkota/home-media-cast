# Security policy

home-media-cast runs on a home network and controls a media player. What is implemented and what
is deliberately not exposed is described in [docs/security.md](docs/security.md) and
[ADR-0007](docs/adr/0007-security-and-network.md).

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private
vulnerability reporting (the **Security** tab, then **Report a vulnerability**) on this
repository. Include what you found, how to reproduce it, and the version or commit.

This is a hobby project, so expect a reply in days, not hours.

## Out of scope

- Exposing the app to the internet. It is designed for a trusted LAN; never use `tailscale funnel`
  or port forwarding for it.
- Kodi's own JSON-RPC (it has no authentication; keep it on loopback).
- Problems in third-party services you connect (AIOStreams, debrid providers, YouTube).

## Never post secrets

Do not paste `.env` contents, API keys, pairing codes, device tokens or provider links into
issues or pull requests.
