# Networking

| Port | Who listens | Reachable from | Notes |
|---|---|---|---|
| **8787/tcp** | the API container (host network) | the LAN, via ufw | API, SSE, OpenAPI and the web UI. `PORT` changes it. |
| 3100/tcp | YouTube Cast receiver (DIAL) | the LAN, via ufw | only while YouTube casting is on. `YOUTUBE_DIAL_PORT` changes it. |
| 1900/udp | YouTube Cast receiver (SSDP) | the LAN, via ufw | discovery for the Cast menu; fixed by SSDP |
| 9090/tcp | Kodi JSON-RPC | **this machine only** | no authentication; binds to `127.0.0.1` |
| 8080/tcp | Kodi web server | nobody | disabled |

Nothing is published to the internet. **Never run `tailscale funnel`** for this project
(ADR-0007).

## ufw

The container uses the host network, so ufw applies to it directly (Docker's usual port
publishing, which bypasses ufw, is not involved). Run once, with sudo:

```bash
sudo ufw status verbose                       # note what is already configured first
sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp comment 'home-media-cast'
sudo ufw status numbered
```

`scripts/ufw-setup.sh` applies the same rule plus the YouTube Cast ones (`--dry-run` prints them,
`--enable` also switches ufw on and makes sure SSH from the LAN stays open; `LAN_CIDR`,
`API_PORT`, `DIAL_PORT` and `YOUTUBE=0` override the defaults; `DIAL_PORT` must match
`YOUTUBE_DIAL_PORT`).
⚠️ unverified: the script has only been dry-run. ufw was disabled on the test machine when it
was last checked, so these rules have not been applied or tested there.

`192.168.1.0/24` is only an example; set `LAN_CIDR` to your own network. Do **not** open
9090 or 8080.

## The API may only call out to

Kodi on loopback, YouTube, metadata services (Cinemeta), your AIOStreams instance and the
providers whose links it returns (for example TorBox).
Links a user pastes are checked against private ranges first (ADR-0007), with an explicit
allowlist: `PLAYBACK_ALLOW_HOSTS`.
