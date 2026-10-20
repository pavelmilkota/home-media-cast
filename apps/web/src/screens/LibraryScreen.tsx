import { grid, screen } from './ui.js';
import { Card } from '@heroui/react';
import type { HistoryEntry, LibraryResponse, TitleSummary } from '@home-media-cast/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { TitleCard } from './TitleCard.js';

export type Open = (t: { id: string; type: TitleSummary['type'] }) => void;

export function Shelf({
  name,
  items,
  onOpen,
  max,
}: {
  name: string;
  items: (TitleSummary | HistoryEntry)[];
  onOpen: Open;
  /** Show at most this many. */
  max?: number;
}) {
  if (items.length === 0) return null;
  const shown = max === undefined ? items : items.slice(0, max);
  return (
    <section aria-label={name} className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{name}</h2>
      <ul className={grid}>
        {shown.map((t) => {
          const h = 'videoId' in t ? t : undefined;
          return (
            <li key={h ? h.videoId : t.id}>
              <TitleCard
                title={t}
                onOpen={onOpen}
                {...(h?.label ? { note: h.label } : {})}
                {...(h ? { progress: h.progress } : {})}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function LibraryScreen({ onOpen }: { onOpen: Open }) {
  const { t } = useTranslation();
  const library = useQuery({
    queryKey: ['library'],
    queryFn: () => api<LibraryResponse>('/library'),
    retry: false,
  });
  const data = library.data;
  const empty = data && data.saved.length + data.favorites.length === 0;
  return (
    <main className={screen}>
      {library.isPending && (
        <p className="text-muted" role="status">
          {t('common.loading')}
        </p>
      )}
      {library.isError && (
        <p role="alert" className="text-danger">
          {library.error.message}
        </p>
      )}
      {empty && (
        <Card>
          <p className="text-muted">{t('library.empty')}</p>
        </Card>
      )}
      {data && (
        <>
          <Shelf name={t('library.myList')} items={data.saved} onOpen={onOpen} />
          <Shelf name={t('library.favorites')} items={data.favorites} onOpen={onOpen} />
        </>
      )}
    </main>
  );
}
