# Home Assistant integration

The web remote is a plain HTTP app on `http://<this PC>:8787` (see `networking.md`). Home
Assistant (HA) can show it in a dashboard of its own, or open it as a link.

⚠️ unverified: the steps below have not been tried against a real HA instance.

## Option 1: a dashboard with a Webpage card

1. Settings → Dashboards → Add dashboard → "New dashboard from scratch". Name it "Cast" and
   tick "Show in sidebar".
2. Open it, then ⋮ → Edit dashboard.
3. Set the view type to **Panel (single card)** so the remote fills the screen.
4. Add a **Webpage** card with `url: http://<this PC>:8787`.

Or paste this into the raw configuration editor:

```yaml
title: Cast
views:
  - title: Remote
    path: remote
    panel: true
    cards:
      - type: iframe
        url: http://192.168.x.x:8787
        aspect_ratio: 100%
```

## Option 2: a button that opens the PWA

Add a button card whose tap action opens the remote in its own tab. It does not embed
anything, so none of the iframe limits below apply.

```yaml
type: button
name: Cast remote
icon: mdi:cast
tap_action:
  action: url
  url_path: http://192.168.x.x:8787
```

`panel_iframe` in `configuration.yaml` also works but is deprecated; use Option 1.

## Things that can break the iframe

- **Mixed content.** If HA is opened over HTTPS (Nabu Casa, a reverse proxy, Tailscale HTTPS),
  the browser blocks an `http://` iframe. Serve the remote over HTTPS too, open HA through its
  local `http://` address, or use Option 2.
- **Firewall.** ufw only allows the LAN range (`192.168.1.0/24` by default) to reach port
  8787. The device running the browser or HA app must be inside it.
- **Pairing.** The remote needs pairing once per browser. Check that the pairing state survives
  inside the iframe; Safari and iOS can drop third-party storage.
- **Framing headers.** The API sets no `X-Frame-Options` or `frame-ancestors` CSP that we know
  of (only searched by name). If the iframe is blank, look at the response headers first.

Never expose port 8787 to the internet to make HA reach it (`networking.md`).
