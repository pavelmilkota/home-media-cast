import { Button, Card, Checkbox, Chip } from '@heroui/react';
import type { CatalogType, StreamOption, StreamsResponse } from '@home-media-cast/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../api/client.js';
import { ageLabel } from '../format.js';
import { useLive } from '../state/live.js';
import { useStartWatch } from './use-start-watch.js';

/** Resolving a debrid link can take a while; this is longer than for a plain link. */
export const SOURCE_START_TIMEOUT_MS = 25_000;

const size = (bytes?: number) =>
  bytes === undefined ? undefined : `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;

const serviceName: Record<string, string> = { torbox: 'TorBox', realdebrid: 'Real-Debrid' };

/** The facts about a release as small badges: [text, tone]. */
function badges(
  o: StreamOption,
  t: TFunction,
): [string, 'accent' | 'default' | 'success' | 'warning'][] {
  const list: [string, 'accent' | 'default' | 'success' | 'warning'][] = [];
  if (o.resolution) list.push([o.resolution, 'accent']);
  if (o.languages?.length) list.push([o.languages.join(', '), 'default']);
  if (o.service) list.push([serviceName[o.service] ?? o.service, 'default']);
  const bytes = size(o.sizeBytes);
  if (bytes) list.push([bytes, 'default']);
  if (o.cached === true) list.push([t('sources.cached'), 'success']);
  if (o.cached === false) list.push([t('sources.notCached'), 'warning']);
  return list;
}

/**
 * The sources AIOStreams finds for one movie or episode, and the button to play one on the TV.
 * `videoId` is `tt…` for a movie and `tt…:season:episode` for an episode. The list is fetched
 * when the picker opens.
 */
export function SourcePicker({
  type,
  videoId,
  heading,
  resumeAt,
  embedded = false,
  onStarted,
  onClose,
  startTimeoutMs = SOURCE_START_TIMEOUT_MS,
}: {
  type: CatalogType;
  videoId: string;
  heading: string;
  /** 0..1 when the library has an unfinished position for this item. */
  resumeAt?: number;
  /** Shown inside the title page (a movie) instead of as a step of its own: no Back, fixed heading. */
  embedded?: boolean;
  onStarted: () => void;
  onClose?: () => void;
  startTimeoutMs?: number;
}) {
  const { t } = useTranslation();
  const { status } = useLive();
  const [confirming, setConfirming] = useState<string | undefined>();
  const [resume, setResume] = useState(true);
  const { phase, begin, arm } = useStartWatch(status, onStarted, startTimeoutMs);

  // Set by Retry: the next fetch asks the server to update its cached list right now.
  const forceRefresh = useRef(false);
  const sources = useQuery({
    queryKey: ['streams', type, videoId],
    queryFn: () => {
      const refresh = forceRefresh.current ? '?refresh=1' : '';
      forceRefresh.current = false;
      return api<StreamsResponse>(
        `/titles/${type}/${encodeURIComponent(videoId)}/streams${refresh}`,
      );
    },
    // Every open reaches the server, which answers from its cache at once and updates in the
    // background. The previous data stays on screen meanwhile; we poll until the update is done.
    staleTime: 0,
    gcTime: 25 * 60_000,
    refetchInterval: (q) => (q.state.data?.refreshing ? 2000 : false),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const retryUpdate = () => {
    forceRefresh.current = true;
    void sources.refetch();
  };

  const play = useMutation({
    mutationFn: (optionId: string) =>
      api('/playback/stream', {
        method: 'POST',
        body: {
          optionId,
          title: { type, id: videoId },
          ...(resumeAt !== undefined && !resume ? { resume: false } : {}),
        },
      }),
    onMutate: begin,
    onSuccess: arm,
    onError: (e) => {
      // 410: the list is older than the server remembers; fetch it again.
      if (e instanceof ApiError && e.status === 410) void sources.refetch();
    },
  });

  const enqueue = useMutation({
    mutationFn: (optionId: string) =>
      api('/queue', { method: 'POST', body: { optionId, title: { type, id: videoId } } }),
  });

  const choose = (o: StreamOption) => {
    // An uncached link can start a download on the debrid account: ask once more first.
    if (o.cached === false && confirming !== o.id) return setConfirming(o.id);
    setConfirming(undefined);
    play.mutate(o.id);
  };
  const busy = play.isPending || phase === 'starting';
  const result = sources.data;

  return (
    <Card role="region" aria-label={t('sources.title')}>
      {!embedded && (
        <Button variant="ghost" className="self-start" onPress={onClose}>
          {t('common.back')}
        </Button>
      )}
      <h2 className="text-xl leading-snug font-semibold wrap-anywhere">
        {embedded ? t('sources.title') : heading}
      </h2>
      {resumeAt !== undefined && (
        <Checkbox isSelected={resume} onChange={setResume}>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>
            {t('sources.resume', { percent: Math.round(resumeAt * 100) })}
          </Checkbox.Content>
        </Checkbox>
      )}
      {sources.isPending && (
        <p className="text-muted" role="status">
          {t('sources.searching')}
        </p>
      )}
      {sources.isError && (
        <>
          <p role="alert" className="text-danger">
            {sources.error.message}
          </p>
          <Button variant="secondary" onPress={() => void sources.refetch()}>
            {t('common.tryAgain')}
          </Button>
        </>
      )}
      {result && (
        <>
          {result.refreshing && (
            <p className="text-muted" role="status">
              {t('sources.updating', { age: ageLabel(result.fetchedAt) })}
            </p>
          )}
          {!result.refreshing && result.refreshError && (
            <div className="flex flex-wrap items-center gap-2" role="status">
              <p className="text-muted">
                {t('sources.couldNotUpdate', { age: ageLabel(result.fetchedAt) })}
              </p>
              <Button variant="secondary" onPress={retryUpdate}>
                {t('common.retry')}
              </Button>
            </div>
          )}
          {result.sourceErrors.length > 0 && (
            <Chip
              color="warning"
              variant="soft"
              className="h-auto self-start py-1 whitespace-normal wrap-anywhere"
            >
              {t('sources.someFailed', { names: result.sourceErrors.join(', ') })}
            </Chip>
          )}
          {result.options.length === 0 && <p className="text-muted">{t('sources.none')}</p>}
          <ul className="grid gap-2">
            {result.options.map((o, i) => (
              <li key={o.id}>
                <Card variant="default" className="gap-3 border border-border">
                  <Card.Content>
                    <Button
                      variant="secondary"
                      className="h-auto min-h-12 w-full flex-col items-start justify-start gap-2 rounded-[16px] px-3 py-2 text-left whitespace-normal wrap-anywhere"
                      isDisabled={!o.playable || busy}
                      onPress={() => choose(o)}
                      aria-describedby={`why-${o.id}`}
                    >
                      <strong className="text-[0.95rem] leading-snug wrap-anywhere">
                        {o.title}
                      </strong>
                      <span className="flex flex-wrap gap-1.5" id={`why-${o.id}`}>
                        {badges(o, t).map(([text, color]) => (
                          <Chip key={text} size="sm" variant="soft" color={color}>
                            {text}
                          </Chip>
                        ))}
                      </span>
                      {o.reason && <span className="text-muted">{o.reason}</span>}
                      {o.playable && (
                        <span aria-hidden="true" className="text-sm font-medium text-accent">
                          {t('sources.playOnTv')}
                        </span>
                      )}
                      {confirming === o.id && (
                        <span role="alert" className="text-danger">
                          {t('sources.notCachedWarning')}
                        </span>
                      )}
                    </Button>
                  </Card.Content>
                  {o.playable && (
                    <Card.Footer className="justify-end">
                      <Button
                        variant="secondary"
                        isDisabled={enqueue.isPending}
                        aria-label={t('sources.addToQueue', { n: i + 1 })}
                        onPress={() => enqueue.mutate(o.id)}
                      >
                        {t('sources.queue')}
                      </Button>
                    </Card.Footer>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      {enqueue.isSuccess && (
        <p className="text-muted" role="status">
          {t('sources.queued')}
        </p>
      )}
      {enqueue.isError && (
        <p role="alert" className="text-danger">
          {enqueue.error.message}
        </p>
      )}
      {phase === 'starting' && (
        <p className="text-muted" role="status">
          {t('sources.waiting')}
        </p>
      )}
      {phase === 'failed' && (
        <p role="alert" className="text-danger">
          {t('sources.failed')}
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
