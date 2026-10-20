# Networking

| Port | Who listens | Reachable from | Notes |
|---|---|---|---|
| **8787/tcp** | the API container (host network) | the LAN, via ufw | API, SSE, OpenAPI and the web UI. `PORT` changes it. |
| 9090/tcp | Kodi JSON-RPC | **this machine only** | no authentication; binds to `127.0.0.1` |
| 8080/tcp | Kodi web server | nobody | disabled |

Nothing is published to the internet. **Never run `tailscale funnel`** for this project.
Stage 2 adds DIAL (TCP, `DIAL_PORT`, spike default 3100) and UDP 1900 for SSDP discovery (ADR-0007).

## ufw

The container uses the host network, so ufw applies to it directly (Docker's usual port
publishing, which bypasses ufw, is not involved). Run once, with sudo:

```bash
sudo ufw status verbose                       # note what is already configured first
sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp comment 'home-media-cast'
sudo ufw status numbered
```

`scripts/ufw-setup.sh` applies the same rules plus the Stage 2 ones (`--dry-run` prints them,
`--enable` also switches ufw on and makes sure SSH from the LAN stays open; `LAN_CIDR`,
`API_PORT`, `DIAL_PORT` and `YOUTUBE=0` override the defaults).
⚠️ unverified: the script has only been dry-run; `/etc/ufw/ufw.conf` on the Dell says
`ENABLED=no`, so ufw was not filtering when it was last read.

`192.168.1.0/24` is only an example; set `LAN_CIDR` to your own network. Do **not** open
9090 or 8080. ⚠️ ufw state on the Dell was not read (it needs sudo), so these rules have
not been applied or tested yet.

## The API may only call out to

Kodi on loopback, and (from Stage 2/3) YouTube, TorBox, metadata services and AIOStreams.
Links a user pastes are checked against private ranges first (ADR-0007), with an explicit
allowlist: `PLAYBACK_ALLOW_HOSTS`.
