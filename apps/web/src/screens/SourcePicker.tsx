import { Button, Card, Chip, ProgressBar, Switch } from '@heroui/react';
import type { CatalogType, StreamOption, StreamsResponse } from '@home-media-cast/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../api/client.js';
import { ageLabel } from '../format.js';
import { useLive } from '../state/live.js';
import {
  NO_FILTERS,
  SourceFilters,
  applyFilters,
  filterChoices,
  hasFilters,
} from './source-filters.js';
import { useQueue } from '../state/queue.js';
import { QueueCard } from './QueueCard.js';
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
  const [filters, setFilters] = useState(NO_FILTERS);
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

  const client = useQueryClient();
  const queued = useQueue().items.some((q) => q.type === type && q.videoId === videoId);
  const enqueue = useMutation({
    mutationFn: (optionId: string) =>
      api('/queue', { method: 'POST', body: { optionId, title: { type, id: videoId } } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['queue'] }),
  });

  const choose = (o: StreamOption) => {
    // An uncached link can start a download on the debrid account: ask once more first.
    if (o.cached === false && confirming !== o.id) return setConfirming(o.id);
    setConfirming(undefined);
    play.mutate(o.id);
  };
  const busy = play.isPending || phase === 'starting';
  const result = sources.data;
  const choices = useMemo(() => filterChoices(result?.options ?? []), [result?.options]);
  const shown = useMemo(
    () => applyFilters(result?.options ?? [], filters),
    [result?.options, filters],
  );

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
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-secondary p-3">
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"
          >
            <svg viewBox="0 0 24 24" width="22" height="22">
              <path
                d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M10 9l5 3-5 3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="grid min-w-0 flex-1 gap-2">
            <Switch isSelected={resume} onChange={setResume} className="w-full justify-between">
              <Switch.Content className="w-full justify-between gap-3 font-medium">
                <span>{t('sources.resume', { percent: Math.round(resumeAt * 100) })}</span>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            <ProgressBar
              aria-hidden="true"
              size="sm"
              value={Math.round(resumeAt * 100)}
              className={resume ? '' : 'opacity-40'}
            >
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
          </div>
        </div>
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
          <SourceFilters choices={choices} filters={filters} onChange={setFilters} />
          {result.options.length === 0 && <p className="text-muted">{t('sources.none')}</p>}
          {result.options.length > 0 && shown.length === 0 && (
            <div className="flex flex-wrap items-center gap-2" role="status">
              <p className="text-muted">{t('sources.filters.noMatch')}</p>
            </div>
          )}
          {shown.length > 0 && hasFilters(filters) && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-muted" role="status">
                {t('sources.filters.shown', { shown: shown.length, total: result.options.length })}
              </p>
            </div>
          )}
          <ul className="grid gap-2">
            {shown.map((o, i) => (
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
                        isDisabled={enqueue.isPending || queued}
                        aria-label={t('sources.addToQueue', { n: i + 1 })}
                        onPress={() => enqueue.mutate(o.id)}
                      >
                        {queued ? t('sources.inQueue') : t('sources.queue')}
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
      <QueueCard />
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
