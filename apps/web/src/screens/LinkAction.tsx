import { Button, Card } from '@heroui/react';
import { parseYouTubeUrl } from '@home-media-cast/shared';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useLive } from '../state/live.js';
import { useStartWatch } from './use-start-watch.js';

/** After the API accepts a link, Kodi has this long to start playing it. */
export const START_TIMEOUT_MS = 10_000;

/** A link on a YouTube host that is not a single video (channel, playlist, home page, ...). */
function isYouTubePageThatIsNotAVideo(text: string): boolean {
  try {
    const host = new URL(text).hostname.toLowerCase();
    const onYouTube =
      host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
    return onYouTube && parseYouTubeUrl(text) === undefined;
  } catch {
    return false;
  }
}

/** The pasted text as a playable web link: http(s), not an IMDb page. Anything else is a title search. */
export function linkOf(text: string): string | undefined {
  const t = text.trim();
  try {
    const url = new URL(t);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const host = url.hostname.toLowerCase();
    if (host === 'imdb.com' || host.endsWith('.imdb.com')) return undefined;
    return t;
  } catch {
    return undefined;
  }
}

export function LinkAction({
  url,
  onStarted,
  startTimeoutMs = START_TIMEOUT_MS,
}: {
  url: string;
  onStarted: () => void;
  startTimeoutMs?: number;
}) {
  const { t } = useTranslation();
  const { status } = useLive();
  const youtube = parseYouTubeUrl(url) !== undefined;
  const notAVideo = isYouTubePageThatIsNotAVideo(url);
  const { phase, begin, arm } = useStartWatch(status, onStarted, startTimeoutMs);

  const play = useMutation({
    mutationFn: () =>
      youtube
        ? api('/playback/youtube', { method: 'POST', body: { url } })
        : api('/playback', { method: 'POST', body: { kind: 'direct_url', url } }),
    onMutate: begin,
    onSuccess: arm,
  });
  const busy = play.isPending || phase === 'starting';

  return (
    <Card>
      <Card.Title>{t('link.title')}</Card.Title>
      <p className="text-muted wrap-anywhere">{url}</p>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        isDisabled={busy || notAVideo}
        onPress={() => play.mutate()}
      >
        {busy ? t('link.starting') : t('link.playOnTv')}
      </Button>
      {youtube && <p className="text-muted">{t('link.youtubeVideo')}</p>}
      {notAVideo && (
        <p role="alert" className="text-danger">
          {t('link.notAVideo')}
        </p>
      )}
      {phase === 'starting' && (
        <p className="text-muted" role="status">
          {t('link.waiting')}
        </p>
      )}
      {phase === 'failed' && (
        <p role="alert" className="text-danger">
          {t('link.failed')}
        </p>
      )}
      {play.isError && (
        <p role="alert" className="text-danger">
          {play.error.message}
        </p>
      )}
    </Card>
  );
}
