# AGENTS.md

Rules for AI coding agents (Claude Code and others). `CLAUDE.md` only points here.

## Hard rules

- **Secrets** (TorBox API key, AIOStreams uuid and password, device tokens) live only in
  `.env` on the host. Never in git, the frontend, logs, or any URL handed to Kodi. When you
  add a variable, add it to `.env.example` too, with a placeholder value.
- **Kodi JSON-RPC (9090) binds to `127.0.0.1` only.** It has no authentication. The frontend
  never talks to Kodi directly and cannot pass an arbitrary method — only the backend's
  fixed set of commands (ADR-0002).
- **Temporary links (TorBox CDN etc.) are never identifiers.** A fresh link is requested
  right before playback (ADR-0005).
- **User-pasted URLs go through the SSRF check**; provider-returned URLs are checked
  against that provider's host allowlist (ADR-0007).
- **Do not claim a feature works before a hands-on test.** Mark anything untested as
  "⚠️ unverified" in the docs — especially YouTube casting and Premium.
- **Check library and API versions against current documentation** (ctx7, npm, official
  docs), not memory. Pin versions, keep the lockfile in git, and pin container images to
  explicit tags.
- Never `tailscale funnel`: nothing is published to the internet.

## Workflow

- Local planning notes (not published, git-ignored) may live in `context/changes/<id>/`.
- All documentation, code comments and commit messages are in English.
- New web UI text goes through `t()`, with the key added to all four locales
  (`apps/web/src/i18n/locales`).
- After each phase run `lint`, `typecheck`, `test` and `build`, and update the docs to
  match what was actually built.
