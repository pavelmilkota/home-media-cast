import { Button, Card } from '@heroui/react';
import type { AdjacentEpisodes } from '@home-media-cast/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { formatTime } from '../format.js';
import { useLive } from '../state/live.js';
import { CommitSlider } from './CommitSlider.js';
import { PauseIcon, PlayIcon, StopIcon } from './icons.js';
import { PickSelect } from './PickSelect.js';
import { sheet } from './ui.js';
import { QueueCard } from './QueueCard.js';

const SKIPS = [-30, -10, 10, 30] as const;

/** Everything the remote does while a video is active. Rendered inside the Remote sheet. */
export function RemotePanel() {
  const { t } = useTranslation();
  const { status } = useLive();
  const command = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api(`/player${path}`, { method: 'POST', body }),
  });
  const send = (path: string, body?: unknown) => command.mutate({ path, body });

  // The episodes around the one on screen. Asked again whenever the video changes.
  const playing = status?.active ? status.title : undefined;
  const around = useQuery({
    queryKey: ['adjacent-episodes', playing],
    queryFn: () => api<AdjacentEpisodes>('/playback/episodes'),
    enabled: playing !== undefined,
    retry: false,
    staleTime: 0,
  });
  const go = useMutation({
    mutationFn: (direction: 'previous' | 'next') =>
      api(`/playback/${direction}`, { method: 'POST' }),
  });

  if (!status?.active) return null;

  const volume = (
    <CommitSlider
      label={t('remote.volume')}
      showLabel
      value={status.volume}
      max={100}
      display={(v) => `${v}%`}
      onCommit={(v) => send('/volume', { volume: v })}
    />
  );

  const paused = status.speed === 0;
  const subtitleValue =
    status.subtitleEnabled && status.currentSubtitle !== null
      ? String(status.currentSubtitle)
      : 'off';
  const trackName = (s: { index: number; name: string; language: string }) =>
    [s.name || t('remote.track', { n: s.index + 1 }), s.language].filter(Boolean).join(' · ');

  return (
    <div className={sheet}>
      <Card>
        <p className="text-muted">{t('remote.nowPlaying')}</p>
        <h2 className="text-xl font-semibold wrap-anywhere">
          {status.title || t('common.untitled')}
        </h2>

        <CommitSlider
          label={t('remote.position')}
          value={status.positionMs}
          max={Math.max(status.durationMs, 1)}
          step={1000}
          onCommit={(v) => send('/seek', { positionMs: v })}
        />
        <div className="flex justify-between text-muted tabular-nums">
          <span>{formatTime(status.positionMs)}</span>
          <span>{formatTime(status.durationMs)}</span>
        </div>

        <div className="flex items-center justify-center gap-2">
          {SKIPS.slice(0, 2).map((s) => (
            <Button
              key={s}
              variant="secondary"
              className="min-w-0 flex-1 px-2"
              onPress={() => send('/seek', { offsetSeconds: s })}
            >
              {t('remote.seconds', { value: s })}
            </Button>
          ))}
          <Button
            variant="primary"
            size="lg"
            className="min-w-24 flex-none px-6"
            onPress={() => send(paused ? '/resume' : '/pause')}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? t('common.play') : t('common.pause')}
          </Button>
          {SKIPS.slice(2).map((s) => (
            <Button
              key={s}
              variant="secondary"
              className="min-w-0 flex-1 px-2"
              onPress={() => send('/seek', { offsetSeconds: s })}
            >
              {t('remote.seconds', { value: `+${s}` })}
            </Button>
          ))}
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="secondary"
            className="min-w-0 flex-1 px-2"
            isDisabled={!around.data?.previous || go.isPending}
            aria-label={
              around.data?.previous
                ? t('remote.previousEpisodeNamed', { label: around.data.previous.label })
                : t('remote.previousEpisode')
            }
            onPress={() => go.mutate('previous')}
          >
            {t('remote.previous')}
          </Button>
          <Button
            variant="danger-soft"
            className="min-w-0 flex-1 px-2"
            onPress={() => send('/stop')}
          >
            <StopIcon />
            {t('common.stop')}
          </Button>
          <Button
            variant="secondary"
            className="min-w-0 flex-1 px-2"
            isDisabled={!around.data?.next || go.isPending}
            aria-label={
              around.data?.next
                ? t('remote.nextEpisodeNamed', { label: around.data.next.label })
                : t('remote.nextEpisode')
            }
            onPress={() => go.mutate('next')}
          >
            {t('remote.next')}
          </Button>
        </div>
        {go.isError && (
          <p role="alert" className="text-danger">
            {go.error.message}
          </p>
        )}
      </Card>

      <QueueCard />

      <Card>{volume}</Card>

      <Card>
        <PickSelect
          label={t('remote.audio')}
          options={
            status.audioStreams.length === 0
              ? [{ id: '', name: t('remote.defaultTrack') }]
              : status.audioStreams.map((s) => ({ id: String(s.index), name: trackName(s) }))
          }
          value={status.currentAudioStream === null ? '' : String(status.currentAudioStream)}
          isDisabled={status.audioStreams.length < 2}
          onChange={(id) => send('/audio', { index: Number(id) })}
        />
        <PickSelect
          label={t('remote.subtitles')}
          options={[
            { id: 'off', name: t('remote.subtitlesOff') },
            ...status.subtitles.map((s) => ({ id: String(s.index), name: trackName(s) })),
          ]}
          value={subtitleValue}
          isDisabled={status.subtitles.length === 0}
          onChange={(id) => send('/subtitle', { index: id === 'off' ? 'off' : Number(id) })}
        />
      </Card>

      {command.isError && (
        <p role="alert" className="text-danger">
          {command.error.message}
        </p>
      )}
    </div>
  );
}
