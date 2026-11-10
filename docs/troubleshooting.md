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
| Playback stops or never starts and you do not know why | the reason is in Kodi's or the API's log | Settings → Logs: the Kodi tab has Kodi's own errors, the App tab the API's warnings (for example *Relay request failed*). The Kodi tab needs `KODI_LOG_DIR` ([kodi-setup.md](kodi-setup.md)) |
| The app shows the pairing screen | guests are switched off (`GUEST_PLAYBACK_ENABLED=false`) | pair the device, or switch guests on |
| A TV control is greyed out and says the TV is not available | the device is a guest and Kodi is down, so it cannot pair either | start Kodi; a guest can still play in the browser |
| A revoked device keeps coming back | revoking ends its stream and TV control, but the device registers again as a guest | `GUEST_PLAYBACK_ENABLED=false` closes the door |
| `ERR_PNPM_IGNORED_BUILDS` on install | pnpm 12 wants every build script approved or denied | `pnpm approve-builds` (or `'!pkg'` to deny); the result is stored in `pnpm-workspace.yaml` |
| Image build is huge or slow | pnpm caches ended up in a layer | the Dockerfile mounts them as build caches; keep it that way |
| Phone cannot open the page | firewall, wrong address, or a different network | see [networking.md](networking.md); the PC's IP may have changed (DHCP) |
| Container fails to start: *no such file or directory* for `/dev/dri/...`, or `RENDER_GID` is not set | compose passes the GPU render node into the container and needs the host's `render` group | set `RENDER_GID` (`getent group render`) and `TRANSCODE_VAAPI_DEVICE` in `.env` ([installation.md](installation.md)). On a host with no GPU, remove the `devices` and `group_add` lines from `compose.yaml` and set `TRANSCODE=software` or `off` |
| Browser playback: "TV only", and the row cannot be started | the browser cannot decode the video and it cannot be converted: above 1080p, Dolby Vision without an HDR10 layer, or `TRANSCODE=off` | play it on the TV, or use "Open in player" with VLC or a similar app |
| Browser playback: the video is black or silent, or the player shows an error, on Safari or an iPhone | the device refused the codec (for example copied HEVC 10-bit, or an audio format it cannot play) | try a source with H.264, or switch the target to the TV. ⚠️ unverified: whether copied HEVC on Safari needs the `hvc1` tag is still open in the spike notes |
| Browser playback fails to start, with *ffmpeg* in Settings → Logs → App | the encoder could not start (wrong render node, or `TRANSCODE_HW_DECODE=true` on a GPU that cannot decode the codec). The app does not switch pipelines by itself | check `TRANSCODE_VAAPI_DEVICE`; set `TRANSCODE_HW_DECODE=false`, or `TRANSCODE=software` |
| Browser playback stalls after a few minutes, or restarts at the same place | the idle limit (60 s without a request) ended the run, or `/tmp` (`TRANSCODE_TMPFS_SIZE`) is full | the next request starts a new run by itself; raise `TRANSCODE_TMPFS_SIZE` if segments are cut early |
| Browser playback loops, a new run every ~20 s, then "Playback failed" | the browser cannot decode the copied stream | the API log has `Player error (copy, …)`; with `TRANSCODE` on, the session converts after a decode error, otherwise play it on the TV or open it in an external player |
| The player opens and at once says "Playback failed" in Chrome | an older build handed the stream to Chrome's own HLS player | update; the log shows `Player error (…): video.4: …DEMUXER_ERROR_COULD_NOT_PARSE` |
| "Play here" does nothing for some Real-Debrid sources, log `url_rejected` | an older build refused provider links over 4 KiB | update (the limit is 16 KiB) |
| Sound ahead of the picture, or subtitles early, after a seek | an API from before the single-clock fix | update; the log line `Run N started at X s (asked Y s)` shows the run's real start |
| "Continue here" opens the title instead of playing | the playing source could not be identified or is not playable here (for example 4K); the old session keeps playing | pick a source on the page that opens; the session starts at the saved position |
