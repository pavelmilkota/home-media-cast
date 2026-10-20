# Kodi setup

Tested with **Kodi 21.3 Omega** installed as the Flatpak `tv.kodi.Kodi`
(JSON-RPC API 13.5.0). The backend is the only client of Kodi's JSON-RPC (ADR-0002).

## Start Kodi

```bash
flatpak run tv.kodi.Kodi
```

Config lives in `~/.var/app/tv.kodi.Kodi/` (not `~/.kodi`).

## Settings → Services → Control

| Setting | Value | Why |
|---|---|---|
| Allow remote control by programs on this system | **on** | the backend connects from the same machine |
| Allow remote control by programs on other systems | **off** | JSON-RPC has no authentication; it must stay on loopback |
| Allow remote control via HTTP (web server) | **off** | not used |

On a fresh Flatpak 21.3 these were already the defaults.

## Verify

```bash
ss -tlnp | grep 9090     # expected: 127.0.0.1:9090 and NOT 0.0.0.0
node -e "const w=new WebSocket('ws://127.0.0.1:9090/jsonrpc');
w.onopen=()=>w.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'JSONRPC.Version'}));
w.onmessage=e=>{console.log(e.data);w.close()}"
```

The port speaks both raw TCP and WebSocket. `docs/kodi/introspect-21.3.json` is the recorded
`JSONRPC.Introspect`; the fake Kodi used in tests validates method names against it.

## Facts that matter

- A container with `network_mode: host` reaches the Flatpak Kodi on `127.0.0.1:9090`
  (verified 2026-10-19).
- A link Kodi cannot play is **accepted** by `Player.Open` and then stops ~100 ms later
  (`Player.OnPlay`, `Player.OnStop`, no `Player.OnAVStart`). No dialog blocked the next
  attempt. The PWA treats "nothing active 10 s after sending" as a failed start.
- ⚠️ Hardware decoding inside the Flatpak is unchecked; the Intel `iHD` VA-API driver loads.
- ⚠️ Kodi may store played URLs in its own video database (ADR-0005). The backend therefore
  never gives Kodi a provider URL: sources from AIOStreams/TorBox are opened as
  `http://127.0.0.1:<port>/api/relay/<id>/<name>` (the TorBox CDN link carries the account key,
  verified). Direct links pasted by the owner and YouTube `plugin://` URLs are still opened as
  they are. The database itself has not been inspected.

## Fullscreen / windowed toggle

`scripts/kodi-keymap.sh` writes `keymaps/keyboard.xml` into the Kodi userdata directory and
binds `F11` to `ToggleFullScreen`. Kodi reads keymaps at startup, so restart it afterwards.
The default path is the Flatpak one (`~/.var/app/tv.kodi.Kodi/data/userdata`); for a native
install run `KODI_USERDATA=~/.kodi/userdata scripts/kodi-keymap.sh`. ⚠️ unverified: the
binding has not been tested hands-on yet.

## TV buttons and "Restart Kodi" (Settings → TV)

"Kodi home" and "Toggle fullscreen" call `GUI.ActivateWindow { window: "home" }` and
`GUI.SetFullscreen { fullscreen: "toggle" }`. The parameter shapes match the recorded
`docs/kodi/introspect-21.3.json`; ⚠️ unverified: they have not been run against the real Kodi.

"Start screensaver" calls `GUI.ActivateScreenSaver` (no params), which starts whichever screensaver
Kodi has selected. It has been run against the real Kodi 21.3.

"Restart Kodi" needs a small host-side watcher (ADR-0008). Without it the button answers
"Restart requested" and nothing happens.

```bash
# 1. The shared directory; uid 1000 is the container's `node` user.
mkdir -p ~/.local/share/home-media-cast/restart
sudo chown 1000:1000 ~/.local/share/home-media-cast/restart   # skip if your uid is 1000
# 2. In .env: KODI_RESTART_DIR=/home/<you>/.local/share/home-media-cast/restart, then
docker compose up -d
# 3. The units. Check ExecStart in kodi-restart.service points at your checkout.
mkdir -p ~/.config/systemd/user
cp scripts/kodi-restart.path scripts/kodi-restart.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kodi-restart.path
```

If the directory is missing or not writable the button reports an error instead of
"requested". The script starts Kodi with `DISPLAY` (default `:0`) and `WAYLAND_DISPLAY` from
the service environment; ⚠️ unverified on the real host, including whether Kodi comes up on
the projector this way.
