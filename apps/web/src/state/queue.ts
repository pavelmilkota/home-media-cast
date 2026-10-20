import type { QueueResponse } from '@home-media-cast/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useLive } from './live.js';

/** The play queue. The backend takes an entry off it when it starts, so ask again when the video changes. */
export function useQueue() {
  const { status } = useLive();
  const playing = status?.active ? status.title : undefined;
  const queue = useQuery({
    queryKey: ['queue', playing],
    queryFn: () => api<QueueResponse>('/queue'),
    retry: false,
    staleTime: 0,
  });
  return { ...queue, items: queue.data?.items ?? [] };
}
