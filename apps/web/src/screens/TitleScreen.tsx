import { Button, Card, ProgressBar, Separator, ToggleButton } from '@heroui/react';
import type { CatalogType, EpisodeInfo, TitleDetail, TitleState } from '@home-media-cast/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { screen } from './ui.js';
import { PickSelect } from './PickSelect.js';
import { SourcePicker } from './SourcePicker.js';

const percent = (p: number) => `${Math.round(p * 100)}%`;

const airDate = (iso: string, locale: string) =>
  new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });

function episodeLabel(e: EpisodeInfo): string {
  return `${e.episode}. ${e.name}`;
}

export function TitleScreen({
  type,
  id,
  onBack,
  onStarted,
}: {
  type: CatalogType;
  id: string;
  onBack: () => void;
  onStarted: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [picking, setPicking] = useState<
    { videoId: string; heading: string; resumeAt?: number } | undefined
  >();
  const [season, setSeason] = useState<number | undefined>();

  const detail = useQuery({
    queryKey: ['title', type, id],
    queryFn: () => api<TitleDetail>(`/catalog/${type}/${id}`),
    retry: false,
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['title', type, id] });
    void client.invalidateQueries({ queryKey: ['library'] });
  };
  const setState = useMutation({
    mutationFn: (change: Partial<TitleState>) =>
      api<TitleState>(`/catalog/${type}/${id}/state`, { method: 'PUT', body: change }),
    onSuccess: refresh,
  });
  const playTrailer = useMutation({
    mutationFn: () => api(`/catalog/${type}/${id}/trailer`, { method: 'POST' }),
  });
  const setWatched = useMutation({
    mutationFn: ({ videoId, watched }: { videoId: string; watched: boolean }) =>
      api(`/catalog/${type}/watched/${videoId}`, { method: 'PUT', body: { watched } }),
    onSuccess: refresh,
  });

  const setSeasonWatched = useMutation({
    mutationFn: ({ season, watched }: { season: number; watched: boolean }) =>
      api(`/catalog/series/${id}/seasons/${season}/watched`, { method: 'PUT', body: { watched } }),
    onSuccess: refresh,
  });

  const d = detail.data;
  const genreNames = t('genres', { returnObjects: true }) as Record<string, string>;
  const seasons = d ? [...new Set(d.episodes.map((e) => e.season))] : [];
  const nextEpisode = d?.episodes.find((e) => e.id === d.nextUp);
  // With nothing left to watch, open the season that has unaired episodes coming.
  const upcoming = d?.episodes.find((e) => e.season > 0 && !e.released);
  const shown =
    season ?? nextEpisode?.season ?? upcoming?.season ?? seasons.find((s) => s > 0) ?? seasons[0];
  const episodes = d?.episodes.filter((e) => e.season === shown) ?? [];
  const airedInSeason = episodes.filter((e) => e.released);
  const hasStills = episodes.some((e) => e.released && e.thumbnail);
  const seasonWatched = airedInSeason.length > 0 && airedInSeason.every((e) => e.watched);

  const started = () => {
    refresh();
    setPicking(undefined);
    onStarted();
  };

  // Picking a source is its own step: the title page is hidden until the picker is closed.
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [picking]);
  if (picking) {
    return (
      <main className={screen}>
        <SourcePicker
          key={picking.videoId}
          type={type}
          videoId={picking.videoId}
          heading={picking.heading}
          {...(picking.resumeAt ? { resumeAt: picking.resumeAt } : {})}
          onStarted={started}
          onClose={() => setPicking(undefined)}
        />
      </main>
    );
  }

  return (
    <main className={screen}>
      <Button variant="ghost" className="self-start" onPress={onBack}>
        {t('common.back')}
      </Button>
      {detail.isPending && (
        <p className="text-muted" role="status">
          {t('common.loading')}
        </p>
      )}
      {detail.isError && (
        <p role="alert" className="text-danger">
          {detail.error.message}
        </p>
      )}
      {d && (
        <>
          <Card className="flex-row gap-4">
            {d.poster && (
              <img
                className="w-24 self-start rounded-[16px]"
                src={d.poster}
                alt=""
                referrerPolicy="no-referrer"
              />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-xl font-semibold wrap-anywhere">{d.name}</h1>
              <p className="text-muted">
                {[
                  d.type === 'movie' ? t('common.movie') : t('common.series'),
                  d.year,
                  d.runtime,
                  d.rating ? `★ ${d.rating}` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {d.genres.length > 0 && (
                <p className="text-muted">{d.genres.map((g) => genreNames[g] ?? g).join(', ')}</p>
              )}
            </div>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={d.state.liked ? 'primary' : 'secondary'}
              aria-pressed={d.state.liked}
              isDisabled={setState.isPending}
              onPress={() => setState.mutate({ liked: !d.state.liked })}
            >
              {d.state.liked ? t('title.liked') : t('title.like')}
            </Button>
            <Button
              variant={d.state.saved ? 'primary' : 'secondary'}
              aria-pressed={d.state.saved}
              isDisabled={setState.isPending}
              onPress={() => setState.mutate({ saved: !d.state.saved })}
            >
              {d.state.saved ? t('title.inMyList') : t('title.addToMyList')}
            </Button>
            {d.trailer && (
              <Button
                variant="secondary"
                isDisabled={playTrailer.isPending}
                onPress={() => playTrailer.mutate()}
              >
                {t('title.trailer')}
              </Button>
            )}
          </div>

          {playTrailer.isSuccess && (
            <p className="text-muted" role="status">
              {t('title.trailerSent')}
            </p>
          )}
          {playTrailer.isError && (
            <p role="alert" className="text-danger">
              {playTrailer.error.message}
            </p>
          )}

          {d.description && <p>{d.description}</p>}
          {d.cast.length > 0 && (
            <p className="text-muted">{t('title.with', { names: d.cast.join(', ') })}</p>
          )}

          {type === 'movie' && (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {d.watched && <p className="text-success">{t('common.watched')}</p>}
                  {d.progress !== undefined && (
                    <p className="text-muted">
                      {t('title.stoppedAt', { percent: percent(d.progress) })}
                    </p>
                  )}
                  <Button
                    variant="secondary"
                    className="ml-auto"
                    aria-pressed={d.watched}
                    isDisabled={setWatched.isPending}
                    onPress={() => setWatched.mutate({ videoId: d.id, watched: !d.watched })}
                  >
                    {d.watched ? t('title.markUnwatched') : t('title.markWatched')}
                  </Button>
                </div>
              </Card>
              <SourcePicker
                embedded
                type={type}
                videoId={d.id}
                heading={t('title.sourcesFor', { name: d.name })}
                {...(d.progress ? { resumeAt: d.progress } : {})}
                onStarted={started}
              />
            </>
          )}

          {type === 'series' && (
            <Card role="region" aria-label={t('title.episodes')}>
              {nextEpisode && (
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  onPress={() =>
                    setPicking({
                      videoId: nextEpisode.id,
                      heading: `S${nextEpisode.season}E${nextEpisode.episode} · ${nextEpisode.name}`,
                      ...(nextEpisode.progress ? { resumeAt: nextEpisode.progress } : {}),
                    })
                  }
                >
                  {t(nextEpisode.progress ? 'title.continue' : 'title.nextUp', {
                    season: nextEpisode.season,
                    episode: nextEpisode.episode,
                  })}
                </Button>
              )}
              {seasons.length > 1 && (
                <PickSelect
                  className="w-full"
                  label={t('title.season')}
                  value={String(shown)}
                  options={seasons.map((n) => ({
                    id: String(n),
                    name: n === 0 ? t('title.specials') : t('title.seasonN', { n }),
                  }))}
                  onChange={(id) => setSeason(Number(id))}
                />
              )}
              {upcoming?.firstAired && (
                <p className="text-muted">
                  {t('title.nextEpisode', {
                    season: upcoming.season,
                    episode: upcoming.episode,
                    date: airDate(upcoming.firstAired, i18n.language),
                  })}
                </p>
              )}
              {airedInSeason.length > 0 && (
                <Button
                  variant="secondary"
                  fullWidth
                  isDisabled={setSeasonWatched.isPending}
                  onPress={() =>
                    setSeasonWatched.mutate({ season: shown!, watched: !seasonWatched })
                  }
                >
                  {seasonWatched ? t('title.markSeasonUnwatched') : t('title.markSeasonWatched')}
                </Button>
              )}
              {d.episodes.length === 0 && <p className="text-muted">{t('title.noEpisodes')}</p>}
              <ul>
                {episodes.map((e, i) => (
                  <li key={e.id}>
                    {i > 0 && <Separator />}
                    <div className="flex items-center gap-3 py-1">
                      <Button
                        variant="ghost"
                        className="h-auto min-h-13 min-w-0 flex-1 items-center justify-start gap-3 rounded-lg px-3 py-2 text-left whitespace-normal wrap-anywhere"
                        isDisabled={!e.released}
                        onPress={() =>
                          setPicking({
                            videoId: e.id,
                            heading: `S${e.season}E${e.episode} · ${e.name}`,
                            ...(e.progress ? { resumeAt: e.progress } : {}),
                          })
                        }
                      >
                        {e.released && e.thumbnail ? (
                          <img
                            className="aspect-video w-24 flex-none rounded-lg object-cover"
                            src={e.thumbnail}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          (!e.released || hasStills) && (
                            <div
                              aria-hidden="true"
                              className="bg-surface-secondary text-muted flex aspect-video w-24 flex-none items-center justify-center rounded-lg text-xl"
                            >
                              {e.released ? '▶' : '⏳'}
                            </div>
                          )
                        )}
                        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                          <strong>{episodeLabel(e)}</strong>
                          <span className="text-muted">
                            {!e.released
                              ? e.firstAired
                                ? t('title.airs', { date: airDate(e.firstAired, i18n.language) })
                                : t('title.notAired')
                              : e.watched
                                ? t('common.watched')
                                : e.progress
                                  ? t('title.stoppedAt', { percent: percent(e.progress) })
                                  : (e.firstAired?.slice(0, 10) ?? '')}
                          </span>
                          {!e.watched && e.progress ? (
                            <ProgressBar
                              className="w-full"
                              aria-label={t('common.progress')}
                              size="sm"
                              value={e.progress * 100}
                            >
                              <ProgressBar.Track>
                                <ProgressBar.Fill />
                              </ProgressBar.Track>
                            </ProgressBar>
                          ) : null}
                        </div>
                      </Button>
                      <ToggleButton
                        isIconOnly
                        className="flex-none"
                        aria-label={t('title.markEpisode', {
                          action: e.watched ? t('title.markUnwatched') : t('title.markWatched'),
                          episode: episodeLabel(e),
                        })}
                        isSelected={e.watched}
                        isDisabled={setWatched.isPending}
                        onChange={(watched) => setWatched.mutate({ videoId: e.id, watched })}
                      >
                        {e.watched ? '✓' : '○'}
                      </ToggleButton>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {(setState.isError || setWatched.isError || setSeasonWatched.isError) && (
            <p role="alert" className="text-danger">
              {(setState.error ?? setWatched.error ?? setSeasonWatched.error)?.message}
            </p>
          )}
        </>
      )}
    </main>
  );
}
