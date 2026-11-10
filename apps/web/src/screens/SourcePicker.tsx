import {
  Button,
  Card,
  Chip,
  ProgressBar,
  Spinner,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  toast,
} from '@heroui/react';
import {
  playbackMode,
  type AudioProbeResponse,
  type BrowserPlayConfig,
  type ExternalSession,
  type CatalogType,
  type StreamOption,
  type StreamsResponse,
} from '@home-media-cast/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../api/client.js';
import { ageLabel, formatTime } from '../format.js';
import { useBrowserPlayer } from '../state/browser-player.js';
import { deviceCaps } from '../state/device-caps.js';
import { useLive } from '../state/live.js';
import { useEffectiveTarget, usePlayTarget } from '../state/play-target.js';
import { useKodiDown, useTvAccess } from '../state/use-tv-access.js';
import {
  NO_FILTERS,
  SourceFilters,
  applyFilters,
  filterChoices,
  hasFilters,
} from './source-filters.js';
import { useQueue } from '../state/queue.js';
import { QueueCard } from './QueueCard.js';
import { OpenInPlayerFallback, useOpenInPlayer } from './use-open-in-player.js';
import { useStartWatch } from './use-start-watch.js';
import { useVisibleIds } from './use-visible-ids.js';

/** Resolving a debrid link can take a while; this is longer than for a plain link. */
export const SOURCE_START_TIMEOUT_MS = 25_000;

const size = (bytes?: number) =>
  bytes === undefined ? undefined : `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;

const serviceName: Record<string, string> = { torbox: 'TorBox', realdebrid: 'Real-Debrid' };

/** Whether the file's own audio tracks can be read: only for links marked cached (as the server). */
const canCheckAudio = (o: StreamOption) =>
  o.kind === 'direct_url' && o.playable && o.cached === true && !o.audioVerified;

/** What the audio badge shows: the release's claim, a check in progress, the file's tracks (✓), or the claim after the file could not be read (✗). */
type AudioState = 'claimed' | 'checking' | 'verified' | 'failed';

/** The facts about a release as small badges: [text, tone]. */
function badges(
  o: StreamOption,
  t: TFunction,
  audio: AudioState,
): [string, 'accent' | 'default' | 'success' | 'warning' | 'danger'][] {
  const list: [string, 'accent' | 'default' | 'success' | 'warning' | 'danger'][] = [];
  if (o.lastUsed) list.push([t('sources.lastSelected'), 'accent']);
  if (o.resolution) list.push([o.resolution, 'accent']);
  if (o.languages?.length) {
    const names = o.languages.join(', ');
    list.push(
      audio === 'verified'
        ? [`✓ ${names}`, 'success']
        : audio === 'failed'
          ? [`✗ ${names}`, 'danger']
          : [names, 'default'],
    );
  }
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
  playerName,
  resumeAt,
  resumeAtMs,
  handoff,
  embedded = false,
  onStarted,
  onClose,
  startTimeoutMs = SOURCE_START_TIMEOUT_MS,
}: {
  type: CatalogType;
  videoId: string;
  heading: string;
  /** What the browser player shows as the title; the heading when absent. */
  playerName?: string;
  /** 0..1 when the library has an unfinished position for this item. */
  resumeAt?: number;
  /** Start the browser player here (handoff); the TV flow ignores it. */
  resumeAtMs?: number;
  /** A handoff that could not pick its source: continue at `positionMs` on `direction`'s device. */
  handoff?: { direction: 'here' | 'tv'; positionMs: number; reason?: string };
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
  const [, setTarget] = usePlayTarget();
  const target = useEffectiveTarget();
  const tv = useTvAccess();
  const kodiDown = useKodiDown();
  // A handoff decides where it goes; otherwise this device's own default does.
  const inBrowser = handoff ? handoff.direction === 'here' : target === 'browser';
  // A guest's own position (`resumeAtMs`) goes with the request only while the resume switch is on.
  const startAtMs =
    handoff?.direction === 'here' ? handoff.positionMs : resume ? resumeAtMs : undefined;
  const browser = useBrowserPlayer();
  // What this browser decodes; read once, it does not change while the page is open.
  const [caps] = useState(deviceCaps);
  // Until the server answers, assume it converts: a label that turns out too cautious is worse.
  const browserConfig = useQuery({
    queryKey: ['browser-play-config'],
    queryFn: () => api<BrowserPlayConfig>('/browser-play/config'),
    enabled: inBrowser,
    staleTime: Infinity,
  });
  const canConvert = browserConfig.data?.transcode ?? true;
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
      inBrowser
        ? browser.start({
            optionId,
            title: { type, id: videoId },
            name: playerName ?? heading,
            ...(resumeAt !== undefined && !resume ? { resume: false } : {}),
            ...(startAtMs !== undefined ? { startMs: startAtMs } : {}),
          })
        : api('/playback/stream', {
            method: 'POST',
            body: {
              optionId,
              title: { type, id: videoId },
              ...(resumeAt !== undefined && !resume ? { resume: false } : {}),
            },
          }),
    onMutate: () => {
      if (!inBrowser) begin();
    },
    onSuccess: () => {
      if (!inBrowser) arm();
    },
    onError: (e) => {
      // 410: the list is older than the server remembers; fetch it again.
      if (e instanceof ApiError && e.status === 410) void sources.refetch();
    },
  });

  // Shown as a toast: the sources list is long, so an inline message would be off screen.
  const playError = play.isError ? play.error.message : undefined;
  useEffect(() => {
    if (!playError) return;
    // A dead or expired link was already tried twice by the backend: offer the next source.
    const dead =
      play.error instanceof ApiError &&
      (play.error.code === 'stream_expired' || play.error.code === 'stream_unreachable');
    const all = sources.data?.options ?? [];
    const next = dead ? all.slice(all.findIndex((o) => o.id === play.variables) + 1) : [];
    const retry = next.find((o) => o.playable && o.cached !== false);
    toast.danger(playError, {
      timeout: 8000,
      ...(retry
        ? { actionProps: { children: t('sources.tryNext'), onPress: () => play.mutate(retry.id) } }
        : {}),
    });
  }, [playError, play.submittedAt]);
  useEffect(() => {
    if (phase === 'failed') toast.danger(t('sources.failed'), { timeout: 8000 });
  }, [phase, t]);

  const client = useQueryClient();
  const queued = useQueue().items.some((q) => q.type === type && q.videoId === videoId);
  const enqueue = useMutation({
    mutationFn: (optionId: string) =>
      api('/queue', { method: 'POST', body: { optionId, title: { type, id: videoId } } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['queue'] }),
  });

  const external = useOpenInPlayer();
  const openExternal = (o: StreamOption) => {
    // The same warning as for playing: an uncached link can start a download on the account.
    if (o.cached === false && confirming !== o.id) return setConfirming(o.id);
    setConfirming(undefined);
    void external.open(
      () =>
        api<ExternalSession>('/browser-play/external', {
          method: 'POST',
          body: {
            optionId: o.id,
            title: { type, id: videoId },
            ...(resumeAt !== undefined && !resume ? { resume: false } : {}),
            ...(startAtMs !== undefined ? { startMs: startAtMs } : {}),
          },
        }),
      o.title,
    );
  };

  const choose = (o: StreamOption) => {
    // An uncached link can start a download on the debrid account: ask once more first.
    if (o.cached === false && confirming !== o.id) return setConfirming(o.id);
    setConfirming(undefined);
    play.mutate(o.id);
  };
  const busy = play.isPending || phase === 'starting';
  const result = sources.data;
  const all = result?.options ?? [];

  // Rows on screen read their file's real audio tracks; the languages the release names stay until
  // the answer arrives. Once read, the file's languages also drive the audio filter, so a language
  // the release did not name (or named wrongly) is added or dropped there. A row that was asked for
  // keeps its query after it is filtered out or scrolled away (the answer is cached).
  const { visible, ref: observe } = useVisibleIds();
  const asked = useRef(new Set<string>());
  const toCheck = all.filter((o) => {
    if (!canCheckAudio(o)) return false;
    if (visible.has(o.id)) asked.current.add(o.id);
    return asked.current.has(o.id);
  });
  const probes = useQueries({
    queries: toCheck.map((o) => ({
      queryKey: ['audio', o.id],
      queryFn: () => api<AudioProbeResponse>(`/streams/options/${encodeURIComponent(o.id)}/audio`),
      staleTime: Infinity,
      gcTime: 25 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
    combine: (results) => new Map(toCheck.map((o, i) => [o.id, results[i]] as const)),
  });
  const audioOf = (o: StreamOption): AudioState => {
    if (o.audioVerified) return 'verified';
    const probe = probes.get(o.id);
    if (probe?.isPending) return 'checking';
    if (!probe) return 'claimed';
    return probe.data?.status === 'ok' ? 'verified' : 'failed';
  };
  const options = all.map((o) => {
    const probe = probes.get(o.id)?.data;
    return !o.audioVerified && probe?.status === 'ok' ? { ...o, languages: probe.languages } : o;
  });
  const choices = filterChoices(options);
  const shown = applyFilters(options, filters);

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
      {handoff && (
        <p role="note" className="rounded-2xl border border-border bg-surface-secondary p-3">
          {t(handoff.direction === 'here' ? 'handoff.pickHere' : 'handoff.pickTv', {
            position: formatTime(handoff.positionMs),
          })}
          {handoff.reason && <span className="block text-sm text-muted">{handoff.reason}</span>}
          <span className="block text-sm text-muted">{t('handoff.pickExternal')}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted" id="play-on-label">
          {t('sources.playOn')}
        </span>
        <ToggleButtonGroup
          aria-labelledby="play-on-label"
          selectionMode="single"
          disallowEmptySelection
          size="sm"
          selectedKeys={[target]}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (next === 'browser') setTarget('browser');
            // TV follows the gate: a guest is sent to pairing and stays on this device.
            else if (next === 'tv') tv.guard(() => setTarget('tv'))();
          }}
        >
          <ToggleButton id="tv" isDisabled={kodiDown || tv.state === 'unavailable'}>
            {t('sources.targetTv')}
          </ToggleButton>
          <ToggleButton id="browser">
            <ToggleButtonGroup.Separator />
            {t('sources.targetBrowser')}
          </ToggleButton>
        </ToggleButtonGroup>
        {(kodiDown || tv.state === 'unavailable') && (
          <span className="w-full text-sm text-muted">{t('tvGate.kodiDown')}</span>
        )}
      </div>
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
          {external.fallback && <OpenInPlayerFallback launch={external.fallback} />}
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
            {shown.map((o, i) => {
              const audio = audioOf(o);
              // Unknown video facts stay playable: the server reads the file when it starts.
              const mode =
                inBrowser && o.video?.codec
                  ? playbackMode(o.video, caps, { transcode: canConvert })
                  : undefined;
              const tvOnly = mode === 'unsupported';
              return (
                <li key={o.id} data-option-id={o.id} ref={observe}>
                  <Card
                    variant="default"
                    className={`gap-3 border ${o.lastUsed ? 'border-2 border-accent bg-accent/10' : 'border-border'}`}
                    data-last-used={o.lastUsed ? 'true' : undefined}
                  >
                    <Card.Content>
                      <Button
                        variant="secondary"
                        className="h-auto min-h-12 w-full flex-col items-start justify-start gap-2 rounded-[16px] px-3 py-2 text-left whitespace-normal wrap-anywhere"
                        isDisabled={!o.playable || busy || tvOnly}
                        onPress={() => choose(o)}
                        aria-describedby={`why-${o.id}`}
                      >
                        <strong className="text-[0.95rem] leading-snug wrap-anywhere">
                          {o.title}
                        </strong>
                        <span className="flex flex-wrap gap-1.5" id={`why-${o.id}`}>
                          {badges(o, t, audio).map(([text, color]) => (
                            <Chip key={text} size="sm" variant="soft" color={color}>
                              {text}
                            </Chip>
                          ))}
                          {tvOnly && (
                            <Chip size="sm" variant="soft" color="warning">
                              {t('sources.tvOnly')}
                            </Chip>
                          )}
                          {mode === 'transcode' && (
                            <Chip size="sm" variant="soft" color="warning">
                              {t('sources.willConvert')}
                            </Chip>
                          )}
                          {audio === 'checking' && (
                            <Chip size="sm" variant="soft" role="status">
                              <Spinner size="sm" />
                              {t('sources.checkingAudio')}
                            </Chip>
                          )}
                        </span>
                        {o.reason && <span className="text-muted">{o.reason}</span>}
                        {o.playable && !tvOnly && (
                          <span aria-hidden="true" className="text-sm font-medium text-accent">
                            {inBrowser ? t('sources.playHere') : t('sources.playOnTv')}
                          </span>
                        )}
                        {confirming === o.id && (
                          <span role="alert" className="text-danger">
                            {t('sources.notCachedWarning')}
                          </span>
                        )}
                      </Button>
                    </Card.Content>
                    {o.playable && (inBrowser || tvOnly) && (
                      <Card.Footer className="justify-end">
                        <Button
                          variant={tvOnly ? 'primary' : 'secondary'}
                          isDisabled={external.busy}
                          onPress={() => openExternal(o)}
                        >
                          {t('external.open')}
                        </Button>
                      </Card.Footer>
                    )}
                    {o.playable && !inBrowser && (
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
              );
            })}
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
    </Card>
  );
}
