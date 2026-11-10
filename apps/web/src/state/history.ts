import type { PlaybackHistoryResponse } from '@home-media-cast/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useLive } from './live.js';

/** The last plays. Ask again when a new video starts, and on window focus. */
export function useHistory() {
  const { status } = useLive();
  const playing = status?.active ? status.title : undefined;
  const history = useQuery({
    queryKey: ['history', playing],
    queryFn: () => api<PlaybackHistoryResponse>('/playback/history'),
    retry: false,
    staleTime: 0,
  });
  return { ...history, items: history.data?.items ?? [] };
}
