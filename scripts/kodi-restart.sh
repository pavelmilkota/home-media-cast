#!/usr/bin/env bash
# Restarts the Flatpak Kodi when the API asks for it (ADR-0008). Run by kodi-restart.service,
# which kodi-restart.path starts when the trigger file appears.
#
# Environment (defaults in brackets):
#   KODI_RESTART_TRIGGER  [~/.local/share/home-media-cast/restart/kodi-restart]  file the API creates
#   KODI_APP_ID           [tv.kodi.Kodi]                                        Flatpak application id
set -euo pipefail

trigger="${KODI_RESTART_TRIGGER:-$HOME/.local/share/home-media-cast/restart/kodi-restart}"
app="${KODI_APP_ID:-tv.kodi.Kodi}"

# Remove the trigger first: if anything below fails, the path unit must not fire again in a loop.
rm -f "$trigger"

flatpak kill "$app" 2>/dev/null || true
sleep 2

# Start Kodi in its own transient unit. As a child of this service it would die with it, and
# the service would never finish, so a second request could not start it again.
systemctl --user stop kodi-app.service 2>/dev/null || true
systemd-run --user --unit=kodi-app --collect \
  --setenv=DISPLAY="${DISPLAY:-:0}" \
  ${WAYLAND_DISPLAY:+--setenv=WAYLAND_DISPLAY="$WAYLAND_DISPLAY"} \
  flatpak run "$app"
