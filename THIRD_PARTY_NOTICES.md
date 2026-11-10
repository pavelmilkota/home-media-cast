# Third-party notices

home-media-cast is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It depends
on third-party packages that keep their own licenses. This file lists the ones that need more than
the usual "permissive license, keep the notice" and summarizes the rest. The exact set for a given
version is in `pnpm-lock.yaml`; each package ships its own `LICENSE` in `node_modules`.

## LGPL-3.0 packages (YouTube cast receiver)

The YouTube casting feature uses [`yt-cast-receiver`](https://github.com/patrickkfkan/yt-cast-receiver)
(MIT), which depends on two packages licensed under the **GNU Lesser General Public License,
version 3** (LGPL-3.0):

| Package | Version | Source | Copyright |
|---|---|---|---|
| `@patrickkfkan/peer-dial` | 0.1.3 | <https://github.com/patrickkfkan/peer-dial> | (c) 2015 Fraunhofer FOKUS; fork by Patrick Kan |
| `@patrickkfkan/peer-ssdp` | 0.1.0 | <https://github.com/patrickkfkan/peer-ssdp> | (c) 2017 Fraunhofer FOKUS; fork by Patrick Kan |

How this project uses them:

- They are **unmodified** and installed from the npm registry as ordinary dependencies. They are
  loaded at run time with `require`/`import`; no code from them is copied into this repository.
- You can replace them with another version or your own build: change the version in
  `apps/api/package.json` (via `yt-cast-receiver`) or use a pnpm override, and rebuild. The Docker
  image is built from source with `docker compose build`.
- The LGPL-3.0 text is in each package's `LICENSE` file, and in full at
  <https://www.gnu.org/licenses/lgpl-3.0.html>. The LGPL covers those packages only; it does not
  change the license of this project's own code.

If you redistribute a built Docker image of this project, keep this file with it and make the
source of these two packages available (the links above are enough while they stay online).

## FFmpeg (browser playback)

Browser playback runs the `ffmpeg` and `ffprobe` programs from the Debian package `ffmpeg`
(`7:5.1.9-0+deb12u1`, pinned in the `Dockerfile`), together with the Intel VAAPI drivers
`i965-va-driver` and `intel-media-va-driver`. FFmpeg is licensed under the LGPL-2.1+, but Debian's
build enables GPL components such as `libx264`, which makes the installed binary GPL-2.0+ as a
whole. ⚠️ unverified: the exact configuration flags of the pinned build have not been read from the
built image.

How this project uses it:

- It is **unmodified** and installed from Debian's archive in the image; it is started as a separate
  process and never linked into the API. No FFmpeg code is in this repository.
- The source of the pinned package is available from Debian (`apt-get source ffmpeg`), and the
  licence texts are in `/usr/share/doc/ffmpeg/copyright` inside the image.
- If you redistribute a built Docker image, keep this file with it and offer the source of these
  packages (the Debian source archive is enough while it stays online). FFmpeg is a trademark of
  its owner; this project is not affiliated with it.

## hls.js (browser player)

[`hls.js`](https://github.com/video-dev/hls.js) `1.7.4` (Apache-2.0) plays HLS in browsers without
native support. It is a dependency of the web app, loaded on demand, and unmodified.

## Other runtime dependencies

All other runtime dependencies of the API and the web app are under permissive licenses (MIT,
Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, and similar). Main ones:

| Area | Packages |
|---|---|
| API | NestJS, Express, `ws`, `zod`, `better-sqlite3`, Drizzle ORM, RxJS, `yt-cast-receiver` (MIT) |
| Web | React, TanStack Router and Query, HeroUI, React Aria, i18next, Tailwind CSS, `hls.js` (Apache-2.0) |

Checked on 2026-10-20 against the installed `node_modules`: no GPL, AGPL, SSPL or
noncommercial-restricted license among the dependencies, apart from the LGPL pair above. A few
old packages (`busboy`, `streamsearch`, `line-by-line`) declare MIT in the legacy `licenses`
field, and `gate` has an MIT `LICENSE` file but no `license` field in its `package.json`.

## External services and trademarks

Kodi, Stremio, AIOStreams, ElfHosted, TorBox, YouTube, Google and Chromecast are trademarks or
projects of their respective owners. This project is not affiliated with them. Kodi, AIOStreams
and the debrid services are separate software or services you install or subscribe to yourself;
none of their code is included here.
