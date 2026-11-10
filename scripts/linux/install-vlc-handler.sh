#!/bin/sh
# Lets the browser's "Open in player" start VLC on this Linux machine (Linux Mint and the like).
# Installs a launcher and registers it for hmc-vlc:// links. Per user, no root needed.
#   ./install-vlc-handler.sh            install
#   ./install-vlc-handler.sh --remove   undo
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="$HOME/.local/bin/hmc-vlc-open"
desktop="$HOME/.local/share/applications/hmc-vlc.desktop"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$bin" "$desktop"
  command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
  echo "Removed."
  exit 0
fi

command -v vlc >/dev/null || { echo "VLC is not installed (sudo apt install vlc)." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is needed." >&2; exit 1; }
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
install -m 755 "$here/hmc-vlc-open" "$bin"
cat > "$desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Home Media Cast: open in VLC
Exec=$bin %u
NoDisplay=true
Terminal=false
MimeType=x-scheme-handler/hmc-vlc;
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
xdg-mime default hmc-vlc.desktop x-scheme-handler/hmc-vlc
echo "Installed. In the browser, tap \"Open in player\"; the first time, allow the browser to open it"
echo "(tick \"Always allow\")."
