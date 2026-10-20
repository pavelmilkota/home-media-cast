import { Logger } from '@nestjs/common';
import type { KodiService } from '../kodi/kodi.service.js';
import type { KodiNotification } from '../kodi/kodi.types.js';

const log = new Logger('YoutubeStart');

/**
 * Opens a YouTube video and, when `startSeconds` is given, seeks once Kodi reports that the
 * video has started. `Player.Open` returns before playback begins (and returns OK even if
 * the addon's wizard blocks it), so the seek has to wait for `Player.OnAVStart`. The caller
 * gets control back as soon as Kodi accepts the video; the seek happens in the background.
 */
export async function openYouTube(
  kodi: KodiService,
  videoId: string,
  startSeconds?: number,
  { seekTimeoutMs = 20_000 }: { seekTimeoutMs?: number } = {},
): Promise<void> {
  if (!startSeconds) {
    await kodi.commands.openYouTube(videoId);
    return;
  }
  // Listen before opening: the notification can arrive before Player.Open's reply.
  const onNotification = ({ method }: KodiNotification) => {
    if (method !== 'Player.OnAVStart') return;
    cleanup();
    kodi.commands
      .seek({ positionMs: startSeconds * 1000 })
      .catch((e: Error) => log.warn(`Could not seek to the start offset: ${e.message}`));
  };
  const cleanup = () => {
    clearTimeout(timer);
    kodi.events.off('notification', onNotification);
  };
  kodi.events.on('notification', onNotification);
  const timer = setTimeout(cleanup, seekTimeoutMs);
  try {
    await kodi.commands.openYouTube(videoId);
  } catch (e) {
    cleanup();
    throw e;
  }
}
