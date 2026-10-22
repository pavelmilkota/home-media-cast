import type { PlayerMedia } from '@home-media-cast/shared';
import { i18n } from './i18n/index.js';

/** 75_000 -> "1:15", 3_725_000 -> "1:02:05". */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function timeAgo(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return i18n.t('time.never');
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return i18n.t('time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return i18n.t('time.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return i18n.t('time.hoursAgo', { count: hours });
  return new Date(timestamp).toLocaleDateString(i18n.language);
}

/** How old a timestamp is, for "results from 3 h ago": minutes, hours, then days. */
export function ageLabel(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return i18n.t('time.justNow');
  if (minutes < 60) return i18n.t('time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return i18n.t('time.hoursAgo', { count: hours });
  return i18n.t('time.daysAgo', { count: Math.floor(hours / 24) });
}

/** A friendly default for the "device name" field. */
export function guessDeviceName(userAgent = navigator.userAgent): string {
  if (/iPad/i.test(userAgent)) return i18n.t('device.ipad');
  if (/iPhone/i.test(userAgent)) return i18n.t('device.iphone');
  if (/Android/i.test(userAgent))
    return /Mobile/i.test(userAgent)
      ? i18n.t('device.androidPhone')
      : i18n.t('device.androidTablet');
  if (/Windows/i.test(userAgent)) return i18n.t('device.windows');
  if (/Mac OS X/i.test(userAgent)) return i18n.t('device.mac');
  if (/Linux/i.test(userAgent)) return i18n.t('device.linux');
  return i18n.t('device.other');
}

/** "S2E5 · Episode name" for an episode, undefined for a film. */
export function episodeLine(media: PlayerMedia): string | undefined {
  if (media.season === undefined) return undefined;
  const code = `S${media.season}E${media.episode ?? '?'}`;
  return media.episodeName ? `${code} · ${media.episodeName}` : code;
}
