import { Button, Card, ProgressBar } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { episodeLine } from '../format.js';
import { useLive } from '../state/live.js';
import { useQueue } from '../state/queue.js';
import { useTvAccess } from '../state/use-tv-access.js';
import { PauseIcon, PlayIcon } from './icons.js';
import { useHandoff } from './use-handoff.js';

/**
 * A bar above the tab bar while a video is active; tapping it opens the Remote sheet. With
 * nothing playing but a queue waiting, it shows the next entry with a button to start it.
 */
export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { status } = useLive();
  const toggle = useMutation({
    mutationFn: (path: '/pause' | '/resume') => api(`/player${path}`, { method: 'POST' }),
  });
  const client = useQueryClient();
  const { items } = useQueue();
  const handoff = useHandoff();
  // A guest sees the TV's status, but every control goes through pairing (or is disabled).
  const tv = useTvAccess();
  const locked = tv.state === 'unavailable';
  const startQueue = useMutation({
    mutationFn: () => api('/queue/next', { method: 'POST' }),
    onSettled: () => client.invalidateQueries({ queryKey: ['queue'] }),
  });
  if (!status?.active && handoff.elsewhere) {
    const there = handoff.elsewhere;
    return (
      <Card className="h-16 w-full max-w-105 flex-row items-center gap-3 rounded-2xl px-4 py-0 shadow-lg">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">
            {there.media?.name ?? t('common.untitled')}
          </span>
          <span className="truncate text-sm text-muted">
            {t('handoff.playingOn', { device: there.deviceName })}
          </span>
        </span>
        <Button
          variant="primary"
          aria-label={t('handoff.continueHere')}
          isDisabled={handoff.busy || locked}
          onPress={tv.guard(() => void handoff.continueHere())}
        >
          {t('handoff.here')}
        </Button>
        <Button
          variant="secondary"
          aria-label={t('handoff.sendToTv')}
          isDisabled={handoff.busy || locked}
          onPress={tv.guard(() => void handoff.sendToTv())}
        >
          {t('handoff.tv')}
        </Button>
      </Card>
    );
  }
  if (!status?.active) {
    const [next] = items;
    if (!next) return null;
    return (
      <Card className="h-16 w-full max-w-105 flex-row items-center gap-3 rounded-2xl px-4 py-0 shadow-lg">
        <span className="min-w-0 flex-1 truncate font-semibold">
          {t('miniPlayer.upNext', { name: next.name })}
          {items.length > 1 && <span className="text-muted"> · +{items.length - 1}</span>}
        </span>
        <Button
          variant="primary"
          isDisabled={startQueue.isPending}
          onPress={() => startQueue.mutate()}
        >
          {t('common.play')}
        </Button>
      </Card>
    );
  }

  const paused = status.speed === 0;
  const title = status.media?.name ?? (status.title || t('common.untitled'));
  const detail = status.media ? episodeLine(status.media) : undefined;
  const percent =
    status.durationMs > 0 ? Math.min(100, (status.positionMs / status.durationMs) * 100) : 0;

  return (
    <Card className="relative h-16 w-full max-w-105 flex-row items-center gap-3 overflow-hidden rounded-2xl px-4 py-0 shadow-lg">
      <ProgressBar
        aria-label={t('miniPlayer.progress')}
        aria-hidden="true"
        size="sm"
        value={percent}
        className="absolute inset-x-0 top-0"
      >
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <Button
        variant="ghost"
        className="h-12 min-w-0 flex-1 justify-start rounded-[16px] px-3"
        aria-label={t('miniPlayer.nowPlaying', { title })}
        onPress={tv.guard(onOpen)}
      >
        <span className="flex min-w-0 flex-col items-start">
          <span className="max-w-full truncate font-semibold">{title}</span>
          {detail && <span className="max-w-full truncate text-sm text-muted">{detail}</span>}
        </span>
      </Button>
      {status.media && (
        <Button
          variant="secondary"
          aria-label={t('handoff.continueHere')}
          isDisabled={handoff.busy || locked}
          onPress={tv.guard(() => void handoff.continueHere())}
        >
          {t('handoff.here')}
        </Button>
      )}
      <Button
        variant="primary"
        isDisabled={toggle.isPending || locked}
        onPress={tv.guard(() => toggle.mutate(paused ? '/resume' : '/pause'))}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
        {paused ? t('common.play') : t('common.pause')}
      </Button>
    </Card>
  );
}
