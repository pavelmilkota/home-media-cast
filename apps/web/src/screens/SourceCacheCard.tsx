import { Button, Card } from '@heroui/react';
import type { StreamsCacheCleared, StreamsCacheStats } from '@home-media-cast/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { ageLabel } from '../format.js';

/** The server's cache of source lists: how much it holds, and a button to forget it all. */
export function SourceCacheCard() {
  const { t } = useTranslation();
  const lists = (count: number) => t('cache.lists', { count });
  const client = useQueryClient();
  const stats = useQuery({
    queryKey: ['streams-cache'],
    queryFn: () => api<StreamsCacheStats>('/streams/cache'),
    retry: false,
  });
  const clear = useMutation({
    mutationFn: () => api<StreamsCacheCleared>('/streams/cache', { method: 'DELETE' }),
    onSuccess: () => {
      // Open pickers must not show lists the server no longer has.
      void client.invalidateQueries({ queryKey: ['streams'] });
      void client.invalidateQueries({ queryKey: ['streams-cache'] });
    },
  });

  return (
    <Card>
      <Card.Title>{t('cache.title')}</Card.Title>
      {stats.data && (
        <p className="text-muted">
          {stats.data.entries === 0 || stats.data.oldestFetchedAt === undefined
            ? t('cache.empty')
            : t('cache.summary', {
                lists: lists(stats.data.entries),
                age: ageLabel(stats.data.oldestFetchedAt),
              })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" isDisabled={clear.isPending} onPress={() => clear.mutate()}>
          {t('cache.clear')}
        </Button>
      </div>
      {clear.isSuccess && (
        <p className="text-muted" role="status">
          {t('cache.cleared', { lists: lists(clear.data.cleared) })}
        </p>
      )}
      {(stats.isError || clear.isError) && (
        <p role="alert" className="text-danger">
          {(clear.error ?? stats.error)?.message}
        </p>
      )}
    </Card>
  );
}
