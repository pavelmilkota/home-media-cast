/**
 * Browser playback (ADR-0009): the contract between the web UI and the session API. Nothing here
 * carries a provider link, a relay id or a release key.
 */

/** What a source's video is, read from its header or, failing that, its release name. */
export interface VideoFacts {
  /** `other` for anything we do not name (MPEG-4 part 2, VC-1...). Absent when unknown. */
  codec?: 'h264' | 'hevc' | 'vp9' | 'av1' | 'other';
  /** Pixel height; absent when unknown. */
  height?: number;
  /** Bits per colour channel; absent when unknown (8 is not assumed). */
  bitDepth?: number;
  /** `dv-fallback` is Dolby Vision with an HDR10 base layer, which plays as HDR10 elsewhere. */
  hdr: 'none' | 'hdr10' | 'dv' | 'dv-fallback';
}

/** What this browser can decode, measured by the client (see `state/device-caps.ts`). */
export interface DeviceCaps {
  h264: boolean;
  hevc: boolean;
  hevc10: boolean;
  vp9: boolean;
  av1: boolean;
  /** The screen reports high dynamic range. */
  hdr: boolean;
}

export interface BrowserAudioTrack {
  /** Index among the file's audio streams, as sent back to switch (Phase 4). */
  index: number;
  language?: string;
  codec?: string;
  channels?: number;
  title?: string;
}

export interface BrowserSubtitleTrack {
  index: number;
  language?: string;
  title?: string;
}

/** One run of `ffmpeg`. Every seek is a new run with a new playlist. */
export interface BrowserRun {
  n: number;
  /** Where in the film this run's playlist starts. Player time = `startMs` + `video.currentTime`. */
  startMs: number;
  /** Path under `/api`, e.g. `/media/<session>/<run>/index.m3u8`. */
  playlistPath: string;
}

import type { AdjacentEpisodes } from './catalog.js';

export interface BrowserSession {
  /** The session's capability. Not the media id, not the option id. */
  id: string;
  /** What other devices see in `BrowserStatus.handoffId`, so a player can tell its own session. */
  handoffId: string;
  run: BrowserRun;
  durationMs: number;
  mode: 'copy' | 'transcode';
  audioTracks: BrowserAudioTrack[];
  /** The audio track playing, an index of `audioTracks`; absent for a file without audio. */
  audioIndex?: number;
  /** The episode before and after this one, for a series played from the catalog. */
  adjacent?: AdjacentEpisodes;
  /** Start the next episode by itself when this one ends (`AUTO_NEXT_EPISODE`). */
  autoNext: boolean;
  /** The subtitle track to show when the player opens (the household's remembered language). */
  subtitleIndex?: number;
  /** Text subtitles only. Cues are at `/media/<id>/<run>/sub<index>.vtt`, relative to `run.startMs`. */
  subtitleTracks: BrowserSubtitleTrack[];
}

/** Why a source cannot play as it is on a device. */
export type CopyBlocker = 'format' | 'codec' | 'dolby-vision' | 'hdr';

/**
 * Can this device play the video as it is (a "copy" run)? The one rule the picker's label and the
 * backend's refusal share, so they cannot disagree. Unknown facts are the caller's business: the
 * picker lets them through, the backend decides after reading the file.
 */
export function copyBlocker(video: VideoFacts, caps: DeviceCaps): CopyBlocker | undefined {
  if (!video.codec || video.codec === 'other') return 'format';
  const decodes =
    video.codec === 'h264'
      ? caps.h264
      : video.codec === 'hevc'
        ? (video.bitDepth ?? 8) > 8
          ? caps.hevc10
          : caps.hevc
        : video.codec === 'vp9'
          ? caps.vp9
          : caps.av1;
  if (!decodes) return 'codec';
  // Dolby Vision without an HDR10 base layer shows wrong colours on a player that ignores it.
  if (video.hdr === 'dv') return 'dolby-vision';
  if ((video.hdr === 'hdr10' || video.hdr === 'dv-fallback') && !caps.hdr) return 'hdr';
  return undefined;
}

/**
 * An external play (VLC and the like): the player reads the file over the LAN from `path`
 * (relative to `/api`). Its position is only an estimate from which bytes it asked for.
 */
export interface ExternalSession {
  /** The session's capability, as in `BrowserSession`. */
  id: string;
  handoffId: string;
  /** e.g. `/media/<session>/file/<name>`; the client prefixes the origin and `/api`. */
  path: string;
  /** Where the player should start, in the film's own time. */
  startMs: number;
  /** Zero when the length could not be read; then there is no position estimate. */
  durationMs: number;
}

/** `GET /browser-play/config`: what this server can do for a browser. */
export interface BrowserPlayConfig {
  /** Video the browser cannot decode is converted to H.264 (`TRANSCODE` is not `off`). */
  transcode: boolean;
}

/** Pictures taller than this are never converted: the TV plays them (or an external player does). */
export const MAX_TRANSCODE_HEIGHT = 1080;

export type PlaybackMode = 'copy' | 'transcode' | 'unsupported';

/**
 * How a source plays on a device: copied when the device decodes it as it is, converted to H.264
 * (with tone mapping for HDR) when it cannot and the picture is at most 1080p, otherwise
 * unsupported. `transcode` is false when the server has conversion switched off. An unknown height
 * is let through; the backend decides after reading the file.
 */
export function playbackMode(
  video: VideoFacts,
  caps: DeviceCaps,
  { transcode }: { transcode: boolean },
): PlaybackMode {
  if (!copyBlocker(video, caps)) return 'copy';
  if (!transcode) return 'unsupported';
  if (video.height !== undefined && video.height > MAX_TRANSCODE_HEIGHT) return 'unsupported';
  return 'transcode';
}
