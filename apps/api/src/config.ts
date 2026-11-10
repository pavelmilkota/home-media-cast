import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  port: number;
  /** SQLite file, or `:memory:` in tests. */
  dbPath: string;
  /**
   * File the "Restart Kodi" button creates for a host-side watcher (ADR-0008). Unset when the
   * database is in memory and `KODI_RESTART_TRIGGER` is not given.
   */
  kodiRestartTrigger?: string;
  /** Directory holding Kodi's `kodi.log`, mounted read-only; the Logs page's Kodi tab is empty without it. */
  kodiLogDir?: string;
  /** Built web UI served by the API; skipped with a warning if the folder does not exist. */
  webDist: string;
  /** Hosts a pasted link may point to even if they are on the LAN (comma-separated in env). */
  playbackAllowHosts: string[];
  /** All three set, or none: AIOStreams stays off. */
  aiostreams?: { url: string; uuid: string; password: string };
  /** Base URL of the Cinemeta metadata service; the public instance when unset. */
  cinemetaUrl?: string;
  /** Start the next episode by itself when one ends (same release group). */
  autoNextEpisode: boolean;
  /** Unpaired devices may register as guests and play in the browser (ADR-0009). */
  guestPlaybackEnabled: boolean;
  /** Browser playback (ADR-0009). */
  browserPlay: {
    /** Where `ffmpeg` writes HLS segments (a tmpfs in the container); emptied at startup. */
    mediaDir: string;
    /** Segments `ffmpeg` may run in front of the player, and kept behind it. */
    aheadSegments: number;
    behindSegments: number;
    /** Converting video the browser cannot decode to H.264 (ADR-0009). */
    transcode: {
      mode: 'vaapi' | 'software' | 'off';
      /** VAAPI only: decode on the GPU as well. */
      hwDecode: boolean;
      /** Render node of the Intel GPU. */
      device: string;
    };
  };
  youtube: {
    /** Initial state of the "YouTube casting" switch; a value saved from the UI wins over it. */
    enabled: boolean;
    /** HTTP port of the DIAL server. UDP 1900 (SSDP) is fixed by the protocol. */
    dialPort: number;
    /** Name shown in the YouTube app's Cast menu. */
    deviceName: string;
  };
}

/** A positive whole number from the environment, else the default. */
const positive = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const url = env['AIOSTREAMS_URL']?.trim();
  const uuid = env['AIOSTREAMS_UUID']?.trim();
  const password = env['AIOSTREAMS_PASSWORD']?.trim();
  const aio =
    url && uuid && password ? { url: url.replace(/\/+$/, ''), uuid, password } : undefined;
  const dbPath = env['DB_PATH'] ?? resolve('data', 'home-media-cast.sqlite');
  const trigger =
    env['KODI_RESTART_TRIGGER']?.trim() ||
    (dbPath === ':memory:' ? undefined : join(dirname(dbPath), 'kodi-restart'));
  return {
    port: Number(env['PORT'] ?? 8787),
    webDist: env['WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
    dbPath,
    ...(trigger ? { kodiRestartTrigger: trigger } : {}),
    ...(env['KODI_LOG_PATH']?.trim() ? { kodiLogDir: env['KODI_LOG_PATH'].trim() } : {}),
    playbackAllowHosts: (env['PLAYBACK_ALLOW_HOSTS'] ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    ...(aio ? { aiostreams: aio } : {}),
    ...(env['CINEMETA_URL']?.trim() ? { cinemetaUrl: env['CINEMETA_URL'].trim() } : {}),
    autoNextEpisode: env['AUTO_NEXT_EPISODE'] !== 'false',
    guestPlaybackEnabled: env['GUEST_PLAYBACK_ENABLED'] !== 'false',
    browserPlay: {
      mediaDir: join(tmpdir(), 'hmc-media'),
      aheadSegments: positive(env['BROWSER_AHEAD_SEGMENTS'], 12),
      behindSegments: positive(env['BROWSER_BEHIND_SEGMENTS'], 6),
      transcode: {
        mode: ['software', 'off'].includes(env['TRANSCODE']?.trim() ?? '')
          ? (env['TRANSCODE']?.trim() as 'software' | 'off')
          : 'vaapi',
        hwDecode: env['TRANSCODE_HW_DECODE'] === 'true',
        device: env['TRANSCODE_VAAPI_DEVICE']?.trim() || '/dev/dri/renderD129',
      },
    },
    youtube: {
      enabled: env['YOUTUBE_CAST_ENABLED'] === 'true',
      dialPort: Number(env['YOUTUBE_DIAL_PORT'] ?? 3100),
      deviceName: env['YOUTUBE_DEVICE_NAME']?.trim() || 'homeMediaCast',
    },
  };
}
