import { screen } from './ui.js';
import { Button, Card } from '@heroui/react';
import type { LibraryResponse, SearchResponse } from '@home-media-cast/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { Shelf, type Open } from './LibraryScreen.js';
import { QueueCard } from './QueueCard.js';

/** The landing page: a way into Search, what to resume, and what you watched lately. */
export function HomeScreen({
  onOpen,
  onSearch,
  onPlayLink,
}: {
  onOpen: Open;
  onSearch: () => void;
  onPlayLink: () => void;
}) {
  const { t } = useTranslation();
  const library = useQuery({
    queryKey: ['library'],
    queryFn: () => api<LibraryResponse>('/library'),
    retry: false,
  });
  // A nice-to-have: when the metadata service is down the shelf is simply absent.
  const popular = useQuery({
    queryKey: ['discover'],
    queryFn: () => api<SearchResponse>('/catalog/discover'),
    retry: false,
    staleTime: 3_600_000,
  });
  const data = library.data;
  const empty = data && data.continueWatching.length + data.history.length === 0;

  return (
    <main className={screen}>
      <Button variant="secondary" size="lg" fullWidth className="justify-start" onPress={onSearch}>
        {t('home.searchButton')}
      </Button>
      {library.isError && (
        <p role="alert" className="text-danger">
          {library.error.message}
        </p>
      )}
      {empty && (
        <Card>
          <Card.Title>{t('home.welcome')}</Card.Title>
          <p className="text-muted">{t('home.welcomeText')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onPress={onSearch}>
              {t('home.searchTitle')}
            </Button>
            <Button variant="secondary" onPress={onPlayLink}>
              {t('home.playLink')}
            </Button>
          </div>
        </Card>
      )}
      <QueueCard />
      {data && (
        <Shelf
          name={t('home.continueWatching')}
          items={data.continueWatching}
          max={8}
          onOpen={onOpen}
        />
      )}
      {popular.data && (
        <Shelf name={t('home.popularNow')} items={popular.data.results} max={8} onOpen={onOpen} />
      )}
      {data && <Shelf name={t('home.history')} items={data.history} max={8} onOpen={onOpen} />}
    </main>
  );
}
