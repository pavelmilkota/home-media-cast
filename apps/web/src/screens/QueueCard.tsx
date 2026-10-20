import { Button, Card } from '@heroui/react';
import type { QueueResponse } from '@home-media-cast/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useLive } from '../state/live.js';

/** What is waiting to play after the current video. Shows nothing while the queue is empty. */
export function QueueCard() {
  const { t } = useTranslation();
  const { status } = useLive();
  const client = useQueryClient();
  // The backend takes an entry off the queue when it starts it, so ask again when the video changes.
  const playing = status?.active ? status.title : undefined;
  const queue = useQuery({
    queryKey: ['queue', playing],
    queryFn: () => api<QueueResponse>('/queue'),
    retry: false,
    staleTime: 0,
  });
  const change = useMutation({
    mutationFn: ({ path, method }: { path: string; method: 'POST' | 'DELETE' }) =>
      api(`/queue${path}`, { method }),
    onSettled: () => client.invalidateQueries({ queryKey: ['queue'] }),
  });

  const items = queue.data?.items ?? [];
  if (items.length === 0 && !change.isError) return null;

  return (
    <Card aria-label={t('queue.title')}>
      <Card.Title>{t('queue.upNext')}</Card.Title>
      <ol className="grid list-inside list-decimal gap-1.5">
        {items.map((q) => (
          <li key={q.id} className="flex items-center justify-between gap-2">
            <span>
              {q.name}
              {q.label && <span className="text-muted"> · {q.label}</span>}
            </span>
            <Button
              variant="secondary"
              aria-label={t('queue.remove', { name: q.name })}
              onPress={() => change.mutate({ path: `/${q.id}`, method: 'DELETE' })}
            >
              ✕
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          isDisabled={change.isPending || items.length === 0}
          onPress={() => change.mutate({ path: '/next', method: 'POST' })}
        >
          {t('queue.playNext')}
        </Button>
        <Button
          variant="secondary"
          isDisabled={change.isPending || items.length === 0}
          onPress={() => change.mutate({ path: '', method: 'DELETE' })}
        >
          {t('queue.clear')}
        </Button>
      </div>
      {change.isError && (
        <p role="alert" className="text-danger">
          {change.error.message}
        </p>
      )}
    </Card>
  );
}
