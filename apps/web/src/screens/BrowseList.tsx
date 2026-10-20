import { Button } from '@heroui/react';
import {
  BROWSE_LISTS,
  MOVIE_GENRES,
  SERIES_GENRES,
  type BrowseList as List,
  type BrowseResponse,
  type CatalogType,
  type TitleSummary,
} from '@home-media-cast/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { grid } from './ui.js';
import { PickSelect } from './PickSelect.js';
import { TitleCard } from './TitleCard.js';

interface Filters {
  type: CatalogType;
  list: List;
  /** A genre name, or a year for `new`; absent means "all" (for `new`: this year). */
  genre?: string;
}

const FIRST_YEAR: Record<CatalogType, number> = { movie: 1920, series: 1960 };

// Kept across mounts so Back from a title page lands on the list that was open.
let remembered: Filters = { type: 'movie', list: 'popular' };

const years = (type: CatalogType): string[] => {
  const out: string[] = [];
  for (let y = new Date().getFullYear(); y >= FIRST_YEAR[type]; y--) out.push(String(y));
  return out;
};

/** Browsable popular / new / featured titles with infinite scroll. */
export function BrowseList({ onOpen }: { onOpen: (t: TitleSummary) => void }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState(remembered);
  const change = (next: Filters) => {
    remembered = next;
    setFilters(next);
  };
  const genre =
    filters.list === 'new' ? (filters.genre ?? String(new Date().getFullYear())) : filters.genre;

  const pages = useInfiniteQuery({
    queryKey: ['browse', filters.type, filters.list, genre ?? ''],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ type: filters.type, list: filters.list });
      if (genre) q.set('genre', genre);
      if (pageParam > 0) q.set('skip', String(pageParam));
      return api<BrowseResponse>(`/catalog/browse?${q}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextSkip,
    staleTime: 30 * 60_000,
    retry: false,
  });

  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = pages;
  const loaded = pages.data?.pages.length ?? 0;
  useEffect(() => {
    if (!sentinel || !hasNextPage || isFetchingNextPage || isError) return;
    // `loaded` re-arms the observer after each page: a still-visible sentinel fires again.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, hasNextPage, isFetchingNextPage, isError, fetchNextPage, loaded]);

  const seen = new Set<string>();
  const items = (pages.data?.pages ?? [])
    .flatMap((p) => p.results)
    .filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  const genres = filters.type === 'movie' ? MOVIE_GENRES : SERIES_GENRES;
  const genreNames = t('genres', { returnObjects: true }) as Record<string, string>;
  const genreName = (g: string) => genreNames[g] ?? g;

  return (
    <section aria-label={t('browse.discover')} className="flex flex-col gap-2">
      <div
        className="mb-3 flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('browse.type')}
      >
        {(['movie', 'series'] as const).map((type) => (
          <Button
            key={type}
            size="sm"
            variant={filters.type === type ? 'primary' : 'secondary'}
            aria-pressed={filters.type === type}
            onPress={() => change({ type, list: filters.list })}
          >
            {type === 'movie' ? t('browse.movies') : t('browse.series')}
          </Button>
        ))}
      </div>
      <div
        className="mb-3 flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('browse.list')}
      >
        {BROWSE_LISTS.map((list) => (
          <Button
            key={list}
            size="sm"
            variant={filters.list === list ? 'primary' : 'secondary'}
            aria-pressed={filters.list === list}
            onPress={() => change({ type: filters.type, list })}
          >
            {t(`browse.lists.${list}`)}
          </Button>
        ))}
        {filters.list === 'new' ? (
          <PickSelect
            ariaLabel={t('browse.year')}
            value={genre ?? ''}
            options={years(filters.type).map((y) => ({ id: y, name: y }))}
            onChange={(y) => change({ ...filters, genre: y })}
          />
        ) : (
          <PickSelect
            ariaLabel={t('browse.genre')}
            value={filters.genre ?? ''}
            options={[
              { id: '', name: t('browse.allGenres') },
              ...genres.map((g) => ({ id: g, name: genreName(g) })),
            ]}
            onChange={(g) =>
              change({
                type: filters.type,
                list: filters.list,
                ...(g ? { genre: g } : {}),
              })
            }
          />
        )}
      </div>

      {pages.isPending && (
        <p className="text-muted" role="status">
          {t('common.loading')}
        </p>
      )}
      {pages.isError && (
        <p role="alert" className="text-danger">
          {pages.error.message}{' '}
          <Button size="sm" variant="secondary" onPress={() => void pages.refetch()}>
            {t('common.tryAgain')}
          </Button>
        </p>
      )}
      {items.length > 0 && (
        <ul className={grid} aria-label={t('browse.titles')}>
          {items.map((t) => (
            <li key={`${t.type}-${t.id}`}>
              <TitleCard title={t} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {pages.data && items.length === 0 && <p className="text-muted">{t('browse.nothing')}</p>}
      {hasNextPage && <div ref={setSentinel} aria-hidden="true" className="h-px" />}
      {isFetchingNextPage && (
        <p className="text-muted" role="status">
          {t('browse.loadingMore')}
        </p>
      )}
    </section>
  );
}
