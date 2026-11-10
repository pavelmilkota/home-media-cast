import { spawn as nodeSpawnProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BrowserAudioTrack, BrowserSubtitleTrack, VideoFacts } from '@home-media-cast/shared';
import { redactLine } from '../redact.js';

/**
 * Everything about `ffmpeg` that can be decided without running it: the arguments, the reading of
 * `ffprobe`'s answer, the environment and the masking of its output. The process itself sits behind
 * `SpawnFn`, so tests use a fake (ADR-0009).
 *
 * `ffmpeg` parses files from a remote server, so it gets only what it needs: the loopback relay
 * URL, integers and fixed strings. It never sees a provider link (the relay holds it), and not the
 * API's environment, which holds `AIOSTREAMS_PASSWORD`.
 */

/** Seconds per HLS segment. A copy run cuts at keyframes, so a segment can be longer. */
export const SEGMENT_SECONDS = 4;

/** `ffmpeg` and `ffprobe` may open only these protocols: the relay (http) and local files. */
const PROTOCOLS = 'http,tcp,file';
/** An input that stalls for this long (microseconds) fails instead of hanging the run. */
const INPUT_TIMEOUT_US = '30000000';

/**
 * For an http input: a connection that ends early is reopened from the byte where it stopped.
 * Without this `ffmpeg` treats a dropped provider connection as the end of the file: the run ends
 * "successfully" mid-film and the player stops or jumps (measured with ffmpeg 5.1).
 */
const reconnectArgs = (url: string): string[] =>
  /^https?:/i.test(url) ? ['-reconnect', '1', '-reconnect_delay_max', '4'] : [];

// ------------------------------------------------------------------------------------ process

/** The part of a child process the session service uses. `ChildProcess` fits it. */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface SpawnOptions {
  /** Run directory: the playlist and the segments are written here with relative names. */
  cwd?: string;
  env: Record<string, string>;
}

export type SpawnFn = (
  file: 'ffmpeg' | 'ffprobe',
  args: readonly string[],
  options: SpawnOptions,
) => ChildLike;

/** No shell, no inherited environment, stdin closed. */
export const nodeSpawn: SpawnFn = (file, args, { cwd, env }) =>
  nodeSpawnProcess(file, [...args], {
    shell: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd ? { cwd } : {}),
  });

/**
 * `PATH` and a locale, and the VAAPI driver choice when the owner set one: nothing else, not
 * `AIOSTREAMS_PASSWORD`, not any other secret.
 */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const driver = source['LIBVA_DRIVER_NAME'];
  return {
    PATH: source['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    ...(driver && /^[a-z0-9_]{1,20}$/i.test(driver) ? { LIBVA_DRIVER_NAME: driver } : {}),
  };
}

/** A line of `ffmpeg`'s output, safe to log: secrets and the relay ids masked. */
export function maskLine(line: string, relayIds: readonly string[] = []): string {
  let out = redactLine(line);
  for (const id of relayIds) if (id) out = out.split(id).join('***');
  return out.slice(0, 300);
}

// ------------------------------------------------------------------------------------- probe

export function buildProbeArgs(url: string): string[] {
  return [
    '-v',
    'error',
    '-hide_banner',
    '-protocol_whitelist',
    PROTOCOLS,
    '-rw_timeout',
    INPUT_TIMEOUT_US,
    ...reconnectArgs(url),
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    url,
  ];
}

export interface ProbedAudio extends BrowserAudioTrack {
  /** `ffprobe`'s codec name ("aac", "eac3"...), used to decide copy or convert. */
  codecName: string;
}

export interface ProbedSubtitle extends BrowserSubtitleTrack {
  /** Ordinal among all the file's subtitle streams (image ones too), for `-map 0:s:N`. */
  streamIndex: number;
}

export interface ProbedMedia {
  durationMs: number;
  video: VideoFacts | undefined;
  audio: ProbedAudio[];
  /** Text subtitles only, at most `MAX_SUBTITLES`. */
  subtitles: ProbedSubtitle[];
}

/** Subtitle codecs that become WebVTT. Image subtitles (PGS, DVD) are not offered. */
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
/** Text subtitle tracks written per run. */
export const MAX_SUBTITLES = 12;

/** `ffprobe` could not make sense of the file. The message names no URL. */
export class ProbeError extends Error {
  override readonly name = 'ProbeError';
}

const MAX_TRACKS = 32;
const text = (v: unknown, max = 60): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};

const VIDEO_CODECS: Record<string, NonNullable<VideoFacts['codec']>> = {
  h264: 'h264',
  hevc: 'hevc',
  vp9: 'vp9',
  av1: 'av1',
};

/** The HDR kind of a video stream from its transfer function and side data. */
function hdrOf(stream: Record<string, unknown>): VideoFacts['hdr'] {
  const hdr10 =
    stream['color_transfer'] === 'smpte2084' || stream['color_transfer'] === 'arib-std-b67';
  const side = Array.isArray(stream['side_data_list']) ? stream['side_data_list'] : [];
  const dv = side.some(
    (d) =>
      d &&
      typeof d === 'object' &&
      /dovi/i.test(String((d as Record<string, unknown>)['side_data_type'])),
  );
  return dv ? (hdr10 ? 'dv-fallback' : 'dv') : hdr10 ? 'hdr10' : 'none';
}

/** Reads the JSON of `ffprobe -show_format -show_streams`. Every field is bounded. */
export function parseProbe(json: unknown): ProbedMedia {
  if (!json || typeof json !== 'object') throw new ProbeError('ffprobe returned nothing');
  const root = json as Record<string, unknown>;
  const streams = Array.isArray(root['streams'])
    ? (root['streams'] as Record<string, unknown>[])
    : [];
  const format = (root['format'] ?? {}) as Record<string, unknown>;

  const v = streams.find(
    (s) =>
      s['codec_type'] === 'video' &&
      !(s['disposition'] as Record<string, unknown> | undefined)?.['attached_pic'],
  );
  if (!v) throw new ProbeError('The file has no video');

  const seconds = Number(format['duration'] ?? v['duration']);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ProbeError('The file has no length');

  const bits =
    int(v['bits_per_raw_sample']) ?? (/10(le|be)?$/.test(String(v['pix_fmt'])) ? 10 : undefined);
  const video: VideoFacts = {
    codec: VIDEO_CODECS[String(v['codec_name'])] ?? 'other',
    ...(int(v['height']) ? { height: int(v['height']) as number } : {}),
    ...(bits ? { bitDepth: bits } : {}),
    hdr: hdrOf(v),
  };

  const tag = (s: Record<string, unknown>, key: string) =>
    text((s['tags'] as Record<string, unknown> | undefined)?.[key]);
  const audio: ProbedAudio[] = [];
  const subtitles: ProbedSubtitle[] = [];
  let subtitleStreams = 0;
  for (const s of streams) {
    if (s['codec_type'] === 'audio' && audio.length < MAX_TRACKS) {
      const channels = int(s['channels']);
      audio.push({
        index: audio.length,
        codecName: text(s['codec_name'], 20) ?? 'unknown',
        ...(tag(s, 'language') && tag(s, 'language') !== 'und'
          ? { language: tag(s, 'language') as string }
          : {}),
        ...(text(s['codec_name'], 20)
          ? { codec: (text(s['codec_name'], 20) as string).toUpperCase() }
          : {}),
        ...(channels && channels <= 32 ? { channels } : {}),
        ...(tag(s, 'title') ? { title: tag(s, 'title') as string } : {}),
      });
    } else if (s['codec_type'] === 'subtitle') {
      const streamIndex = subtitleStreams++;
      if (subtitles.length >= MAX_SUBTITLES || !TEXT_SUBTITLES.has(String(s['codec_name']))) {
        continue;
      }
      subtitles.push({
        index: subtitles.length,
        streamIndex,
        ...(tag(s, 'language') && tag(s, 'language') !== 'und'
          ? { language: tag(s, 'language') as string }
          : {}),
        ...(tag(s, 'title') ? { title: tag(s, 'title') as string } : {}),
      });
    }
  }
  return { durationMs: Math.round(seconds * 1000), video, audio, subtitles };
}

// -------------------------------------------------------------------------------------- run

export interface RunPlan {
  /** The loopback relay URL. */
  url: string;
  startMs: number;
  /** Ordinal among the file's audio streams; negative for none. */
  audioIndex: number;
  /** `ffprobe`'s name of that stream's codec. */
  audioCodec: string;
  segmentSeconds?: number;
  /** How the video is made; absent copies it. */
  transcode?: TranscodePlan;
  /** Stream ordinals of the text subtitles to write as `sub<n>.vtt`, n being the position here. */
  subtitleStreams?: readonly number[];
}

export interface TranscodePlan {
  encoder: 'vaapi' | 'software';
  /** VAAPI only: decode on the GPU too. Off where the GPU lacks the codec (HEVC 10-bit on the Dell). */
  hwDecode: boolean;
  /** Render node, e.g. `/dev/dri/renderD129`. VAAPI only. */
  device: string;
  /** The source is HDR: map it to SDR so it does not look washed out. */
  tonemap: boolean;
}

/** Seconds with milliseconds, e.g. `83.250`. */
const seconds = (ms: number): string => (Math.max(0, Math.round(ms)) / 1000).toFixed(3);

/**
 * HDR to SDR in software: linearise, map to BT.709 with Hable, and back to 8-bit. The input is
 * stated as PQ / BT.2020 because Dolby Vision without a base layer carries no such tags and
 * `zscale` refuses an unspecified one. HLG is rare in this catalog and is mapped as PQ (⚠️ unverified).
 */
const TONEMAP_SOFTWARE =
  'zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,' +
  'zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** What goes before `-i` and what the video is encoded with. ⚠️ unverified on real hardware. */
function transcodeArgs(
  t: TranscodePlan,
  segmentSeconds: number,
): { input: string[]; video: string[] } {
  // `t` is the film's time (`-copyts`), so count from the last forced keyframe, not from zero.
  const keyframes = [
    '-force_key_frames',
    `expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+${segmentSeconds}))`,
    '-bf',
    '0',
  ];
  if (t.encoder === 'software') {
    return {
      input: [],
      video: [
        '-vf',
        t.tonemap ? TONEMAP_SOFTWARE : 'format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-profile:v',
        'high',
        '-sc_threshold',
        '0',
        ...keyframes,
      ],
    };
  }
  const encode = ['-c:v', 'h264_vaapi', '-qp', '24', '-profile:v', 'high', ...keyframes];
  if (t.hwDecode) {
    return {
      input: ['-hwaccel', 'vaapi', '-hwaccel_device', t.device, '-hwaccel_output_format', 'vaapi'],
      video: [
        '-vf',
        t.tonemap ? 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709' : 'scale_vaapi=format=nv12',
        ...encode,
      ],
    };
  }
  return {
    input: ['-init_hw_device', `vaapi=va:${t.device}`, '-filter_hw_device', 'va'],
    video: ['-vf', `${t.tonemap ? `${TONEMAP_SOFTWARE},` : ''}format=nv12,hwupload`, ...encode],
  };
}

/**
 * Arguments for one run. The video is repackaged as it is (copy) or converted to H.264 (transcode);
 * the audio is copied when it is AAC and converted to stereo AAC otherwise; the result is HLS with
 * fMP4 segments. Text subtitles go to `sub<n>.vtt` files from the same read. The files go to the
 * working directory under fixed relative names, so no path is in the arguments.
 *
 * Timestamps stay the film's own (`-copyts`): a copy run starts at the keyframe before `startMs`,
 * not at `startMs`, and only one clock shared by video, audio and subtitles keeps them in step.
 * The run's real start is read back from its first segment (`firstSegmentStartMs`).
 */
export function buildRunArgs(plan: RunPlan): string[] {
  const aac = plan.audioCodec === 'aac';
  const segmentSeconds = plan.segmentSeconds ?? SEGMENT_SECONDS;
  const video = plan.transcode ? transcodeArgs(plan.transcode, segmentSeconds) : undefined;
  const subtitles = (plan.subtitleStreams ?? []).slice(0, MAX_SUBTITLES);
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-protocol_whitelist',
    PROTOCOLS,
    '-rw_timeout',
    INPUT_TIMEOUT_US,
    ...reconnectArgs(plan.url),
    ...(video?.input ?? []),
    // Every stream starts at the keyframe before `startMs`. Accurate seeking would trim converted
    // audio to `startMs` but leave copied video at the keyframe, and the gap between them is kept
    // only in an MP4 edit list that browsers ignore: the sound would run ahead of the picture.
    ...(plan.startMs > 0 ? ['-ss', seconds(plan.startMs), '-noaccurate_seek'] : []),
    '-copyts',
    '-i',
    plan.url,
    // Subtitles first: output options belong to the output file that follows them.
    // Each written out at once: otherwise they sit in ffmpeg's 32 KB buffer, and a subtitle file
    // stays empty until the run ends (measured: 0 bytes mid-run), so no cue ever shows.
    ...subtitles.flatMap((stream, n) => [
      '-map',
      `0:s:${Math.trunc(stream)}`,
      '-c:s',
      'webvtt',
      '-flush_packets',
      '1',
      '-f',
      'webvtt',
      `sub${n}.vtt`,
    ]),
    '-map',
    '0:v:0',
    // A file without an audio stream (a negative index) is played silent rather than refused.
    ...(plan.audioIndex >= 0 ? ['-map', `0:a:${Math.trunc(plan.audioIndex)}`] : []),
    '-sn',
    '-dn',
    ...(video ? video.video : ['-c:v', 'copy']),
    ...(plan.audioIndex < 0
      ? []
      : aac
        ? ['-c:a', 'copy']
        : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
    '-f',
    'hls',
    '-hls_time',
    String(segmentSeconds),
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_flags',
    'independent_segments+temp_file',
    '-hls_segment_filename',
    'seg%d.m4s',
    'index.m3u8',
  ];
}

// ------------------------------------------------------------------------------- probe run

const MAX_PROBE_OUTPUT = 2 * 1024 * 1024;

/** `ffprobe` is not installed or could not be started. */
export class FfmpegMissingError extends Error {
  override readonly name = 'FfmpegMissingError';
}

/**
 * Runs `ffprobe` on the relay URL and returns what it found. `relayIds` are masked in anything
 * that is logged. Rejects with `ProbeError` or `FfmpegMissingError`; neither message has a URL.
 */
export function probeMedia(
  spawn: SpawnFn,
  url: string,
  { timeoutMs = 45_000, relayIds = [] }: { timeoutMs?: number; relayIds?: readonly string[] } = {},
  log: (line: string) => void = () => undefined,
): Promise<ProbedMedia> {
  return new Promise((resolve, reject) => {
    let child: ChildLike;
    try {
      child = spawn('ffprobe', buildProbeArgs(url), { env: minimalEnv() });
    } catch {
      return reject(new FfmpegMissingError('ffprobe could not be started'));
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new ProbeError('ffprobe timed out')));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > MAX_PROBE_OUTPUT) {
        child.kill('SIGKILL');
        finish(() => reject(new ProbeError('ffprobe wrote too much')));
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      err = (err + d.toString('utf8')).slice(-2000);
    });
    child.on('error', (e) =>
      finish(() =>
        reject(
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? new FfmpegMissingError('ffprobe is not installed')
            : new ProbeError('ffprobe could not be started'),
        ),
      ),
    );
    child.on('exit', (code) =>
      finish(() => {
        if (code !== 0) {
          for (const line of err.split('\n').filter(Boolean).slice(-3))
            log(maskLine(line, relayIds));
          return reject(new ProbeError('ffprobe could not read the file'));
        }
        try {
          resolve(parseProbe(JSON.parse(out) as unknown));
        } catch (e) {
          reject(
            e instanceof ProbeError ? e : new ProbeError('ffprobe returned something unreadable'),
          );
        }
      }),
    );
  });
}
