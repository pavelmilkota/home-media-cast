import type { KodiClient } from './kodi.client.js';
import { KodiInvalidUrlError, KodiNoActivePlayerError } from './kodi.errors.js';
import type { KodiStream, PlayerStatus, SeekTarget } from './kodi.types.js';

interface KodiTime {
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

interface RawStream {
  index: number;
  name?: string;
  language?: string;
}

/** A YouTube video id: 11 characters of base64url. Nothing else ever reaches the plugin URL. */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const toMs = (t: KodiTime): number =>
  ((t.hours * 60 + t.minutes) * 60 + t.seconds) * 1000 + t.milliseconds;

const fromMs = (ms: number): KodiTime => ({
  hours: Math.floor(ms / 3_600_000),
  minutes: Math.floor(ms / 60_000) % 60,
  seconds: Math.floor(ms / 1000) % 60,
  milliseconds: Math.floor(ms) % 1000,
});

const toStreams = (raw: RawStream[] | undefined): KodiStream[] =>
  (raw ?? []).map((s) => ({ index: s.index, name: s.name ?? '', language: s.language ?? '' }));

/**
 * A label can be the raw URL for items without metadata, query string and all. Keep only a
 * file-name-like part; never return anything after `?` or `#`, where tokens live.
 */
export function safeTitle(item: { title?: string; label?: string } | undefined): string {
  const text = item?.title || item?.label || '';
  let segment: string;
  try {
    const url = new URL(text);
    segment = url.pathname.split('/').filter(Boolean).pop() ?? url.hostname;
  } catch {
    segment = text.split(/[?#]/)[0] ?? '';
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed % escape: keep the undecoded (still query-free) segment
  }
}

/** Kodi's Apple Aerials screensaver plays as an ordinary video player; it is not something the user cast. */
const AMBIENT_VIDEO = /^https?:\/\/sylvan\.apple\.com\/Aerials\//i;

/**
 * The only operations the backend may perform on Kodi (ADR-0002). The frontend can never
 * pass an arbitrary JSON-RPC method; every method name below is fixed.
 */
export class KodiCommands {
  constructor(private readonly client: KodiClient) {}

  async open(url: string, options: { resume?: boolean } = {}): Promise<void> {
    // Kodi would also open plugin://, special://, smb:// and `url|Header=...`; allow plain http(s) only.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new KodiInvalidUrlError('Not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new KodiInvalidUrlError('Only http(s) URLs can be played');
    }
    if (url.includes('|')) throw new KodiInvalidUrlError('URL must not contain "|"');
    await this.client.request('Player.Open', {
      item: { file: parsed.href },
      options: { resume: options.resume ?? false },
    });
  }

  /**
   * Plays a YouTube video through the Kodi YouTube addon. The `plugin://` URL is fixed here and
   * only a validated video id is put into it, so a caller can never choose the plugin path.
   */
  async openYouTube(videoId: string): Promise<void> {
    if (!YOUTUBE_VIDEO_ID.test(videoId)) throw new KodiInvalidUrlError('Not a YouTube video id');
    await this.client.request('Player.Open', {
      item: { file: `plugin://plugin.video.youtube/play/?video_id=${videoId}` },
    });
  }

  async playPause(play?: boolean): Promise<void> {
    const playerid = await this.activePlayerId();
    await this.client.request('Player.PlayPause', { playerid, play: play ?? 'toggle' });
  }

  async seek(target: SeekTarget): Promise<void> {
    const playerid = await this.activePlayerId();
    let value: unknown;
    if ('positionMs' in target) {
      value = { time: fromMs(Math.max(0, target.positionMs)) };
    } else if ('percentage' in target) {
      value = { percentage: Math.min(100, Math.max(0, target.percentage)) };
    } else {
      value = { seconds: Math.trunc(target.offsetSeconds) };
    }
    await this.client.request('Player.Seek', { playerid, value });
  }

  async stop(): Promise<void> {
    const playerid = await this.activePlayerId();
    await this.client.request('Player.Stop', { playerid });
  }

  async setVolume(volume: number): Promise<void> {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      throw new RangeError('Volume must be an integer from 0 to 100');
    }
    await this.client.request('Application.SetVolume', { volume });
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.client.request('Application.SetMute', { mute: muted });
  }

  async setAudioStream(index: number): Promise<void> {
    const playerid = await this.activePlayerId();
    await this.client.request('Player.SetAudioStream', { playerid, stream: index });
  }

  /** `'off'` hides subtitles; a number selects that stream and shows it. */
  async setSubtitle(index: number | 'off'): Promise<void> {
    const playerid = await this.activePlayerId();
    await this.client.request(
      'Player.SetSubtitle',
      index === 'off' ? { playerid, subtitle: 'off' } : { playerid, subtitle: index, enable: true },
    );
  }

  /**
   * Switches Kodi's window between windowed and full screen (the same as F11 on the TV's keyboard).
   * Not `GUI.SetFullscreen`: that toggles the fullscreen video view, not the application window.
   */
  async toggleFullscreen(): Promise<void> {
    await this.client.request('Input.ExecuteAction', { action: 'togglefullscreen' });
  }

  /** Opens Kodi's home window, e.g. to leave a menu or a finished video behind. */
  async showHome(): Promise<void> {
    await this.client.request('GUI.ActivateWindow', { window: 'home' });
  }

  /** Starts Kodi's screensaver now, without waiting for the idle delay. */
  async activateScreensaver(): Promise<void> {
    await this.client.request('GUI.ActivateScreenSaver');
  }

  async showNotification(title: string, message: string, displayTimeMs = 5000): Promise<void> {
    await this.client.request('GUI.ShowNotification', {
      title,
      message,
      displaytime: Math.max(1500, displayTimeMs),
    });
  }

  async getStatus(): Promise<PlayerStatus> {
    const app = await this.client.request<{ volume: number; muted: boolean }>(
      'Application.GetProperties',
      { properties: ['volume', 'muted'] },
    );
    const player = await this.firstPlayer();
    if (!player) return { active: false, volume: app.volume, muted: app.muted };

    const props = await this.client.request<{
      speed: number;
      time: KodiTime;
      totaltime: KodiTime;
      audiostreams?: RawStream[];
      currentaudiostream?: RawStream | null;
      subtitles?: RawStream[];
      currentsubtitle?: RawStream | null;
      subtitleenabled: boolean;
    }>('Player.GetProperties', {
      playerid: player.playerid,
      properties: [
        'speed',
        'time',
        'totaltime',
        'audiostreams',
        'currentaudiostream',
        'subtitles',
        'currentsubtitle',
        'subtitleenabled',
      ],
    });
    const item = await this.client.request<{
      item?: { title?: string; label?: string; file?: string };
    }>('Player.GetItem', { playerid: player.playerid, properties: ['title', 'file'] });
    if (item.item?.file && AMBIENT_VIDEO.test(item.item.file)) {
      return { active: false, volume: app.volume, muted: app.muted };
    }
    return {
      active: true,
      playerId: player.playerid,
      speed: props.speed,
      positionMs: toMs(props.time),
      durationMs: toMs(props.totaltime),
      title: safeTitle(item.item),
      audioStreams: toStreams(props.audiostreams),
      currentAudioStream: props.currentaudiostream?.index ?? null,
      subtitles: toStreams(props.subtitles),
      currentSubtitle: props.currentsubtitle?.index ?? null,
      subtitleEnabled: props.subtitleenabled,
      volume: app.volume,
      muted: app.muted,
    };
  }

  private async activePlayerId(): Promise<number> {
    const player = await this.firstPlayer();
    if (!player) throw new KodiNoActivePlayerError();
    return player.playerid;
  }

  /** The first active player, ignoring picture players: Kodi's slideshow screensaver is one, and it is not a video. */
  private async firstPlayer(): Promise<{ playerid: number } | undefined> {
    const players =
      await this.client.request<{ playerid: number; type?: string }[]>('Player.GetActivePlayers');
    return players.find((p) => p.type !== 'picture');
  }
}
