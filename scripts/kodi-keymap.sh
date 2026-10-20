#!/usr/bin/env bash
# Installs a Kodi keymap that binds F11 to fullscreen/windowed toggle (docs/kodi-setup.md).
# Idempotent: overwrites the same file. Kodi reads keymaps at startup, so restart it afterwards.
#
#   scripts/kodi-keymap.sh
#
# Environment (defaults in brackets):
#   KODI_USERDATA  [~/.var/app/tv.kodi.Kodi/data/userdata]  Flatpak path; use ~/.kodi/userdata for a native install
set -euo pipefail

KODI_USERDATA="${KODI_USERDATA:-$HOME/.var/app/tv.kodi.Kodi/data/userdata}"
dir="$KODI_USERDATA/keymaps"

mkdir -p "$dir"
cat > "$dir/keyboard.xml" <<'XML'
<keymap>
  <global>
    <keyboard>
      <f11>ToggleFullScreen</f11>
    </keyboard>
  </global>
</keymap>
XML
echo "wrote $dir/keyboard.xml - restart Kodi to apply"
