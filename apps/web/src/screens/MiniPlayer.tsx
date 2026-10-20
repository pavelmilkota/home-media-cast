import { Button, Card, ProgressBar } from '@heroui/react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useLive } from '../state/live.js';

/** A bar above the tab bar while a video is active. Tapping it opens the Remote sheet. */
export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { status } = useLive();
  const toggle = useMutation({
    mutationFn: (path: '/pause' | '/resume') => api(`/player${path}`, { method: 'POST' }),
  });
  if (!status?.active) return null;

  const paused = status.speed === 0;
  const title = status.title || t('common.untitled');
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
        onPress={onOpen}
      >
        <span className="truncate font-semibold">{title}</span>
      </Button>
      <Button
        variant="primary"
        isDisabled={toggle.isPending}
        onPress={() => toggle.mutate(paused ? '/resume' : '/pause')}
      >
        {paused ? t('common.play') : t('common.pause')}
      </Button>
    </Card>
  );
}
