# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` says `kodi: unreachable` | Kodi is not running, or JSON-RPC is off | start Kodi; check Settings → Services → Control; `ss -tlnp \| grep 9090` |
| `docker compose up` loops with `EADDRINUSE` | something already listens on the port (often a `node apps/api/dist/main.js` started by hand) | stop it, or use another port: `PORT=8788 docker compose up -d` |
| "Show code on TV" fails: *Kodi is not reachable* (503) | the code can only be shown on Kodi | fix Kodi first |
| "Wait a few seconds…" (429) when asking for a code | 10 s cooldown | wait |
| "Invalid or expired code" | wrong, expired (5 min), already used, or 5 wrong tries cancelled it | ask for a new code |
| Link rejected: *address is not allowed* (422) | the host is on a private, loopback or tailnet address | intended; for a trusted LAN host add it to `PLAYBACK_ALLOW_HOSTS` |
| "The TV did not start the video" | Kodi accepted the link but could not play it (bad link, 404, unsupported) | check the link; try another |
| The app returns to the pairing screen | the device was revoked, or the database was recreated | pair again |
| `ERR_PNPM_IGNORED_BUILDS` on install | pnpm 12 wants every build script approved or denied | `pnpm approve-builds` (or `'!pkg'` to deny); the result is stored in `pnpm-workspace.yaml` |
| Image build is huge or slow | pnpm caches ended up in a layer | the Dockerfile mounts them as build caches; keep it that way |
| Phone cannot open the page | firewall, wrong address, or a different network | see [networking.md](networking.md); the PC's IP may have changed (DHCP) |
