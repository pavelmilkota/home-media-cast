#!/usr/bin/env bash
# Opens exactly the ports home-media-cast needs, from the LAN only (docs/networking.md).
# Idempotent: ufw skips a rule that already exists. Never opens 9090 (Kodi JSON-RPC) or 8080.
#
#   sudo scripts/ufw-setup.sh [--dry-run] [--enable]
#
# Environment (defaults in brackets):
#   LAN_CIDR   [192.168.1.0/24]  the only network allowed in
#   API_PORT   [8787]             API, SSE and web UI
#   DIAL_PORT  [3100]             YouTube Cast (DIAL) HTTP port, Stage 2
#   YOUTUBE    [1]                0 skips the Stage 2 rules (UDP 1900 + DIAL port)
set -euo pipefail

LAN_CIDR="${LAN_CIDR:-192.168.1.0/24}"
API_PORT="${API_PORT:-8787}"
DIAL_PORT="${DIAL_PORT:-3100}"
YOUTUBE="${YOUTUBE:-1}"
DRY_RUN=0
ENABLE=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --enable) ENABLE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! [[ "$LAN_CIDR" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then
  echo "LAN_CIDR must look like 192.168.1.0/24, got: $LAN_CIDR" >&2; exit 2
fi
for p in "$API_PORT" "$DIAL_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= 65535 )) || { echo "bad port: $p" >&2; exit 2; }
done
if [[ "$API_PORT" == 9090 || "$API_PORT" == 8080 || "$DIAL_PORT" == 9090 || "$DIAL_PORT" == 8080 ]]; then
  echo "refusing to open 9090 or 8080 (Kodi): see AGENTS.md" >&2; exit 2
fi

if (( DRY_RUN == 0 && EUID != 0 )); then
  echo "run with sudo (or use --dry-run to print the commands)" >&2; exit 1
fi
command -v ufw >/dev/null || { echo "ufw is not installed" >&2; exit 1; }

run() { echo "+ $*"; (( DRY_RUN )) || "$@"; }
allow() { # proto port comment
  run ufw allow from "$LAN_CIDR" to any port "$2" proto "$1" comment "$3"
}

allow tcp "$API_PORT" 'home-media-cast API'
if [[ "$YOUTUBE" == 1 ]]; then
  allow udp 1900 'home-media-cast DIAL discovery (SSDP)'
  allow tcp "$DIAL_PORT" 'home-media-cast DIAL (YouTube Cast)'
fi

if (( ENABLE )); then
  # Enabling a default-deny firewall can cut off SSH. Make sure it stays reachable.
  if (( DRY_RUN == 0 )) && ! ufw status | grep -qE '^(22|OpenSSH)\b'; then
    echo "no SSH rule found; adding one from $LAN_CIDR so enabling cannot lock you out"
    run ufw allow from "$LAN_CIDR" to any port 22 proto tcp comment 'ssh from LAN'
  fi
  run ufw --force enable
else
  echo
  echo "ufw was not enabled by this script (add --enable to do so)."
  grep -E '^ENABLED' /etc/ufw/ufw.conf 2>/dev/null || true
fi

(( DRY_RUN )) || ufw status numbered
