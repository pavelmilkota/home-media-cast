# Hardware: the PC next to the TV or projector (research, 2026-10-20)

Goal: Kodi on a 4K HDR display; 4K HEVC Main10 must be decoded in **hardware**, and the box
should be quiet and low power. A used mini PC is enough. This is desk research: ⚠️ none of the
devices below was bought or tried by the maintainers. Prices change, so none are quoted. The
development host is an older workstation whose Intel HD 530 cannot decode HEVC Main10 in
hardware, which is why it is only a test machine.

## What to look for

- **Hardware HEVC Main10 + VP9 profile 2:** Intel Kaby Lake (7th gen) / Gemini Lake or newer,
  AMD Raven Ridge or newer. **Skylake (6th gen, `i5-6xxx`) has the same HD 530 as the test machine: avoid.**
- **Native HDMI 2.0a** for 4K60 + HDR. Kaby Lake NUCs use an LSPCON converter chip, and HDR
  through it was reported broken on Linux/LibreELEC (4K60 works). Gemini Lake has native HDMI 2.0a.
- No AV1 hardware decode below Intel 11th gen / AMD RDNA2; not reachable in this budget and
  rarely needed (AIOStreams sources are H.264/HEVC; YouTube falls back to VP9).

## Shortlist

| Pick | Why | Catch |
|---|---|---|
| **Intel NUC7PJYH** (Pentium J5005) | Native HDMI 2.0a, HEVC10 + VP9 hardware, ~18 W, quiet, 2 HDMI; the one HTPC-friendly choice | check that Wi-Fi is included if you need it (Ethernet is there) |
| Intel NUC7i3BNH / NUC7i5BNH (Kaby Lake) | Faster CPU, HEVC10 in hardware, 4K60 | HDR via LSPCON ⚠️ unreliable on Linux |
| Dell Wyse 5070 (J4105) | Same GPU generation as the J5005, very cheap | HDMI is 1.4, so 4K60/HDR needs an active DP→HDMI 2.0 adapter ⚠️ |

Avoid: HP t630 (AMD GX-420, no HEVC10 hardware), Lenovo M710q with `i5-6400T` (Skylake),
anything 5th/6th gen.

## Recommendation

The **NUC7PJYH** is the best fit for a small budget. Before paying for a used one, confirm that
it boots and shows HDMI output on a 4K display, that the original PSU is included, and that you
can return it. Budget a little extra for a bigger SSD and an HDMI cable rated for 4K HDR.

## HDR check (2026-10-20) — ⚠️ not guaranteed

- Intel's [NUC7CJY/NUC7PJY spec](https://www.intel.com/content/dam/support/us/en/documents/mini-pcs/nuc-kits/NUC7xJY_TechProdSpec.pdf)
  confirms HEVC 8/10-bit and VP9 decode, native HDMI 2.0a, HDCP 2.2, max 8 GB RAM, Wi-Fi AC 9462.
  It says **nothing about HDR**, and lists HDMI output as "4096x2160 @ 60 Hz, 24 bpp".
- Community reports (LibreELEC/Kodi forums, 2018-2021; Reddit was not checked):
  HDR works on Gemini Lake (J5005 on a [LibreELEC devel build, 2021](https://forum.libreelec.tv/thread/13738-intel-true-10bits-hevc-hdr-support/?pageNo=42)),
  but **4K24 HDR worked and 4K60 HDR did not** in experimental builds
  ([thread](https://forum.libreelec.tv/thread/13738-intel-true-10bits-hevc-hdr-support/?pageNo=6)).
  Nothing recent found. Needs "Allow using DRM PRIME decoder" in Kodi.
- Reading: films are 24 fps, so 4K24 HDR (Kodi "adjust display refresh rate") is the realistic
  case; **4K60 HDR cannot be promised**. Buy only with a return option, and test on the display.

## If 4K60 HDR is a hard requirement (2026-10-20)

The NUC7PJYH cannot promise it (above). Candidates, none bought or tried:

| Option | 4K60 HDR10 | Catch |
|---|---|---|
| **Raspberry Pi 5** (LibreELEC 12, Kodi 21) | Hardware HEVC 4K60, HDR10, 8/10/12-bit output ([CNX](https://cnx-software.com/news/libreelec), [Jeff Geerling](https://www.jeffgeerling.com/blog/2024/can-raspberry-pi-5-handle-4k/)) | H.264/VP9/AV1 decode in software (fine at 1080p, drops frames at 4K). LibreELEC is an appliance OS, so the backend and YouTube Cast receiver (ADR-0001) need a different home: LibreELEC Docker add-on, Raspberry Pi OS with Kodi, or the homeserver (which ADR-0001 rejected). |
| Raspberry Pi 4 | HEVC 4K60 hardware; early LibreELEC builds were limited to 30 Hz | Same OS catch; older, slower. |
| Intel N100 mini PC (Beelink S12 Pro class) | ⚠️ HDR on Intel Gen12 under Kodi GBM not verified (page 403); has AV1 and HEVC10 hardware | HDR needs a Kodi GBM session, not a desktop. Keeps the current x86 architecture. |

## Still open

- The display's HDMI input: is it HDMI 2.0 with HDCP 2.2 (needed for 4K60 HDR)?
- Whether Kodi 21 on a desktop Linux or LibreELEC is better on Gemini Lake (HDR needs GBM, no desktop).
  LibreELEC would replace the desktop + Flatpak setup; check against ADR-0001 first.
- Audio: through the display, or a separate receiver (passthrough)?
