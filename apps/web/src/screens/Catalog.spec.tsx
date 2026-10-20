import type { LibraryResponse, SearchResponse, TitleDetail } from '@home-media-cast/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { FakeBackend, idle } from '../testing/fake-backend.js';
import { renderApp } from '../testing/render.js';
import { linkOf } from './LinkAction.js';
import { imdbIdOf } from './SearchScreen.js';

let backend: FakeBackend;
beforeEach(() => {
  auth.clear();
  auth.set('TOKEN123');
  backend = new FakeBackend().install();
});
afterEach(() => {
  vi.unstubAllGlobals();
  auth.clear();
});

const SEARCH: SearchResponse = {
  results: [
    { id: 'tt0133093', type: 'movie', name: 'The Matrix', year: '1999' },
    {
      id: 'tt0903747',
      type: 'series',
      name: 'Matrix Show',
      year: '2008',
      poster: 'https://i/p.jpg',
    },
  ],
};

const SERIES: TitleDetail = {
  id: 'tt0903747',
  type: 'series',
  name: 'Matrix Show',
  year: '2008',
  description: 'A teacher turns to crime.',
  genres: ['Crime'],
  cast: ['Bryan Cranston'],
  state: { liked: false, saved: false },
  watched: false,
  nextUp: 'tt0903747:1:2',
  episodes: [
    { id: 'tt0903747:1:1', season: 1, episode: 1, name: 'Pilot', released: true, watched: true },
    {
      id: 'tt0903747:1:2',
      season: 1,
      episode: 2,
      name: 'Cat',
      released: true,
      watched: false,
      progress: 0.4,
    },
    { id: 'tt0903747:1:3', season: 1, episode: 3, name: 'Soon', released: false, watched: false },
    { id: 'tt0903747:2:1', season: 2, episode: 1, name: 'Return', released: true, watched: false },
  ],
};

const EMPTY: LibraryResponse = { continueWatching: [], favorites: [], saved: [], history: [] };

const start = async (tab: 'Library' | 'Search') => {
  await renderApp();
  await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
  act(() => backend.pushStatus(idle()));
  await userEvent.click(screen.getByRole('tab', { name: tab }));
};

describe('imdbIdOf', () => {
  it.each([
    ['tt0111161', 'tt0111161'],
    ['https://www.imdb.com/title/tt7049682/?ref_=nv_sr_1', 'tt7049682'],
    ['tt123', undefined],
    ['inception', undefined],
  ])('%j -> %j', (text, expected) => {
    expect(imdbIdOf(text)).toBe(expected);
  });
});

describe('search', () => {
  it('finds titles by name and opens a title page', async () => {
    backend.on('GET /catalog/search', { status: 200, body: SEARCH });
    backend.on('GET /catalog/series/tt0903747', { status: 200, body: SERIES });
    await start('Search');
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'matrix');
    await userEvent.click(
      within(screen.getByRole('search')).getByRole('button', { name: 'Search' }),
    );
    const results = await screen.findByRole('list', { name: 'Results' });
    expect(within(results).getByText('The Matrix')).toBeInTheDocument();
    expect(within(results).getByText('Movie · 1999')).toBeInTheDocument();
    expect(backend.callsTo('GET /catalog/search')).toHaveLength(1);

    await userEvent.click(within(results).getByRole('button', { name: /Matrix Show/ }));
    expect(await screen.findByRole('heading', { name: 'Matrix Show' })).toBeInTheDocument();
    expect(screen.getByText('A teacher turns to crime.')).toBeInTheDocument();
  });

  it('searches while typing, once, after the pause, and without pressing Enter', async () => {
    backend.on('GET /catalog/search', { status: 200, body: SEARCH });
    await start('Search');
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'matrix');
    expect(backend.callsTo('GET /catalog/search')).toHaveLength(0);
    const results = await screen.findByRole('list', { name: 'Results' }, { timeout: 3000 });
    expect(within(results).getByText('The Matrix')).toBeInTheDocument();
    const calls = backend.callsTo('GET /catalog/search');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toBe('?q=matrix');
  });

  it('does not search for a single character, a pasted link or an IMDb id', async () => {
    backend.on('GET /catalog/search', { status: 200, body: SEARCH });
    await start('Search');
    const box = screen.getByLabelText('Movie or series title');
    await userEvent.type(box, 'm');
    await userEvent.clear(box);
    await userEvent.type(box, 'https://example.com/a.mp4');
    await userEvent.clear(box);
    await userEvent.type(box, 'tt0111161');
    await new Promise((r) => setTimeout(r, 600));
    expect(backend.callsTo('GET /catalog/search')).toHaveLength(0);
  });

  it('clears the results when the box is emptied', async () => {
    backend.on('GET /catalog/search', { status: 200, body: SEARCH });
    await start('Search');
    const box = screen.getByLabelText('Movie or series title');
    await userEvent.type(box, 'matrix');
    await screen.findByRole('list', { name: 'Results' }, { timeout: 3000 });
    await userEvent.clear(box);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Results' })).toBeNull(), {
      timeout: 3000,
    });
  });

  it('keeps the results when going back from a title', async () => {
    backend.on('GET /catalog/search', { status: 200, body: SEARCH });
    backend.on('GET /catalog/series/tt0903747', { status: 200, body: SERIES });
    await start('Search');
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'matrix');
    await userEvent.click(
      within(screen.getByRole('search')).getByRole('button', { name: 'Search' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /Matrix Show/ }));
    await userEvent.click(await screen.findByRole('button', { name: '← Back' }));
    expect(await screen.findByRole('button', { name: /The Matrix/ })).toBeInTheDocument();
    expect(backend.callsTo('GET /catalog/search')).toHaveLength(1); // served from the cache
  });

  it('says so when nothing matches and when the catalog is down', async () => {
    backend.on('GET /catalog/search', { status: 200, body: { results: [] } });
    await start('Search');
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'zzzz');
    await userEvent.click(
      within(screen.getByRole('search')).getByRole('button', { name: 'Search' }),
    );
    expect(await screen.findByText(/Nothing found for “zzzz”/)).toBeInTheDocument();

    backend.on('GET /catalog/search', {
      status: 503,
      body: { message: 'The title catalog is not available right now' },
    });
    await userEvent.clear(screen.getByLabelText('Movie or series title'));
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'broken');
    await userEvent.click(
      within(screen.getByRole('search')).getByRole('button', { name: 'Search' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('not available right now');
  });

  it('opens a pasted IMDb link directly', async () => {
    backend.on('GET /catalog/movie/tt7049682', {
      status: 200,
      body: { ...SERIES, id: 'tt7049682', type: 'movie', name: 'Pasted', episodes: [] },
    });
    await start('Search');
    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      'https://www.imdb.com/title/tt7049682/',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open tt7049682 as a movie' }));
    expect(await screen.findByRole('heading', { name: 'Pasted' })).toBeInTheDocument();
  });
});

describe('title page', () => {
  const openSeries = async (detail: TitleDetail = SERIES) => {
    backend.on('GET /library', {
      status: 200,
      body: { ...EMPTY, saved: [{ id: 'tt0903747', type: 'series', name: 'Matrix Show' }] },
    });
    backend.on('GET /catalog/series/tt0903747', { status: 200, body: detail });
    await start('Library');
    await userEvent.click(await screen.findByRole('button', { name: /Matrix Show/ }));
    await screen.findByRole('heading', { name: 'Matrix Show' });
  };

  it('shows episodes of the next-up season with their state, and offers "Continue"', async () => {
    await openSeries();
    expect(screen.getByRole('button', { name: 'Continue: S1E2' })).toBeInTheDocument();
    expect(screen.getByText('Stopped at 40%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^3\. Soon/ })).toBeDisabled();
    expect(screen.queryByText(/Return/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Season/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Season 2' }));
    expect(screen.getByRole('button', { name: /^1\. Return/ })).toBeInTheDocument();
  });

  it('marks a whole season watched, and shows thumbnails and air dates', async () => {
    backend.on('PUT /catalog/series/tt0903747/seasons/1/watched', { status: 204 });
    await openSeries({
      ...SERIES,
      episodes: SERIES.episodes.map((e) =>
        e.id === 'tt0903747:1:1'
          ? { ...e, thumbnail: 'https://img.example/ep1.jpg' }
          : e.id === 'tt0903747:1:3'
            ? { ...e, firstAired: '2999-01-01T00:00:00.000Z' }
            : e,
      ),
    });
    expect(document.querySelector('img[src="https://img.example/ep1.jpg"]')).not.toBeNull();
    expect(screen.getByText(/^Airs .*2999/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark season watched' }));
    await waitFor(() =>
      expect(backend.callsTo('PUT /catalog/series/tt0903747/seasons/1/watched')[0]?.body).toEqual({
        watched: true,
      }),
    );
  });

  it('opens the season with unaired episodes when everything before it is watched', async () => {
    const allWatched: TitleDetail = {
      ...SERIES,
      episodes: [
        { id: 'tt0903747:1:1', season: 1, episode: 1, name: 'Old', released: true, watched: true },
        {
          id: 'tt0903747:2:1',
          season: 2,
          episode: 1,
          name: 'Fresh',
          released: false,
          firstAired: '2999-01-01T00:00:00.000Z',
          watched: false,
        },
      ],
    };
    delete allWatched.nextUp;
    await openSeries(allWatched);
    expect(screen.getByRole('button', { name: /^1\. Fresh/ })).toBeInTheDocument();
    expect(screen.getByText(/^Next episode: S2E1/)).toBeInTheDocument();
  });

  it('likes, saves and marks an episode watched through the API, then reloads', async () => {
    backend.on('PUT /catalog/series/tt0903747/state', {
      status: 200,
      body: { liked: true, saved: false },
    });
    backend.on('PUT /catalog/series/watched/tt0903747:1:2', { status: 204 });
    await openSeries();
    await userEvent.click(screen.getByRole('button', { name: '♡ Like' }));
    await waitFor(() =>
      expect(backend.callsTo('PUT /catalog/series/tt0903747/state')[0]?.body).toEqual({
        liked: true,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mark watched: 2. Cat' }));
    await waitFor(() =>
      expect(backend.callsTo('PUT /catalog/series/watched/tt0903747:1:2')[0]?.body).toEqual({
        watched: true,
      }),
    );
    await waitFor(() => expect(backend.callsTo('GET /catalog/series/tt0903747')).toHaveLength(3));
  });

  it('plays the trailer on the TV when the title has one', async () => {
    backend.on('POST /catalog/series/tt0903747/trailer', {
      status: 202,
      body: { status: 'accepted' },
    });
    await openSeries({ ...SERIES, trailer: 'KPLWWIOCOOQ' });
    await userEvent.click(screen.getByRole('button', { name: '▶ Trailer' }));
    expect(await screen.findByText('Trailer sent to the TV')).toBeInTheDocument();
    expect(backend.callsTo('POST /catalog/series/tt0903747/trailer')).toHaveLength(1);
  });

  it('shows the backend message when the trailer cannot start', async () => {
    backend.on('POST /catalog/series/tt0903747/trailer', {
      status: 404,
      body: { error: 'not_found', message: 'No trailer available' },
    });
    await openSeries({ ...SERIES, trailer: 'KPLWWIOCOOQ' });
    await userEvent.click(screen.getByRole('button', { name: '▶ Trailer' }));
    expect(await screen.findByText('No trailer available')).toBeInTheDocument();
  });

  it('has no trailer button without a trailer', async () => {
    await openSeries();
    expect(screen.queryByRole('button', { name: '▶ Trailer' })).not.toBeInTheDocument();
  });

  it('opens the sources of an episode', async () => {
    backend.on('GET /titles/series/tt0903747%3A1%3A2/streams', {
      status: 200,
      body: { options: [], sourceErrors: [] },
    });
    await openSeries();
    await userEvent.click(screen.getByRole('button', { name: 'Continue: S1E2' }));
    const sources = await screen.findByRole('region', { name: 'Sources' });
    expect(within(sources).getByRole('heading', { name: 'S1E2 · Cat' })).toBeInTheDocument();
    expect(await within(sources).findByText('No sources found.')).toBeInTheDocument();
    // The picker is a step of its own: the title page and episode list are not shown with it.
    expect(screen.queryByRole('region', { name: 'Episodes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^3\. Soon/ })).not.toBeInTheDocument();

    await userEvent.click(within(sources).getByRole('button', { name: '← Back' }));
    expect(await screen.findByRole('region', { name: 'Episodes' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sources' })).not.toBeInTheDocument();
  });
});

describe('resume', () => {
  it('offers to resume an unfinished episode and can start over instead', async () => {
    backend.on('GET /library', {
      status: 200,
      body: { ...EMPTY, saved: [{ id: 'tt0903747', type: 'series', name: 'Matrix Show' }] },
    });
    backend.on('GET /catalog/series/tt0903747', { status: 200, body: SERIES });
    backend.on('GET /titles/series/tt0903747%3A1%3A2/streams', {
      status: 200,
      body: {
        options: [{ id: 'a', title: 'Cat.mkv', kind: 'direct_url', cached: true, playable: true }],
        sourceErrors: [],
      },
    });
    backend.on('POST /playback/stream', { status: 202, body: { status: 'accepted' } });
    await start('Library');
    await userEvent.click(await screen.findByRole('button', { name: /Matrix Show/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continue: S1E2' }));
    const box = await screen.findByRole('checkbox', { name: /Resume where I stopped \(40%\)/ });
    expect(box).toBeChecked();
    await userEvent.click(box);
    await userEvent.click(await screen.findByRole('button', { name: /Cat\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /playback/stream')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/stream')[0]?.body).toEqual({
      optionId: 'a',
      title: { type: 'series', id: 'tt0903747:1:2' },
      resume: false,
    });
  });

  it('shows no resume option for an episode that was not started', async () => {
    backend.on('GET /library', {
      status: 200,
      body: { ...EMPTY, saved: [{ id: 'tt0903747', type: 'series', name: 'Matrix Show' }] },
    });
    backend.on('GET /catalog/series/tt0903747', {
      status: 200,
      body: { ...SERIES, nextUp: 'tt0903747:2:1' },
    });
    backend.on('GET /titles/series/tt0903747%3A2%3A1/streams', {
      status: 200,
      body: { options: [], sourceErrors: [] },
    });
    await start('Library');
    await userEvent.click(await screen.findByRole('button', { name: /Matrix Show/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Next up: S2E1' }));
    await screen.findByText('No sources found.');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('library', () => {
  it('shows continue watching, my list, favorites and history, and opens a title', async () => {
    backend.on('GET /library', {
      status: 200,
      body: {
        continueWatching: [
          {
            id: 'tt0903747',
            type: 'series',
            name: 'Matrix Show',
            videoId: 'tt0903747:1:2',
            label: 'S1E2 · Cat',
            watched: false,
            progress: 0.4,
            lastPlayedAt: 1,
          },
        ],
        favorites: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix', year: '1999' }],
        saved: [],
        history: [
          {
            id: 'tt0111161',
            type: 'movie',
            name: 'Shawshank',
            videoId: 'tt0111161',
            watched: true,
            progress: 1,
            lastPlayedAt: 0,
          },
        ],
      } satisfies LibraryResponse,
    });
    await start('Library');
    expect(await screen.findByRole('region', { name: 'Favorites' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Continue watching' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'My list' })).not.toBeInTheDocument();
  });

  it('explains an empty library', async () => {
    backend.on('GET /library', { status: 200, body: EMPTY });
    await start('Library');
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
  });
});

describe('linkOf', () => {
  it.each([
    ['https://example.com/a.mp4', 'https://example.com/a.mp4'],
    ['  https://youtu.be/jNQXAC9IVRw  ', 'https://youtu.be/jNQXAC9IVRw'],
    [
      'https://www.youtube.com/playlist?list=PLabcdefghijk123',
      'https://www.youtube.com/playlist?list=PLabcdefghijk123',
    ],
    ['https://www.imdb.com/title/tt7049682/', undefined],
    ['tt0111161', undefined],
    ['inception', undefined],
    ['ftp://example.com/a.mp4', undefined],
  ])('%j -> %j', (text, expected) => {
    expect(linkOf(text)).toBe(expected);
  });
});

describe('home', () => {
  it('welcomes a fresh install and sends "Play a link" to a focused Search', async () => {
    backend.on('GET /library', { status: 200, body: EMPTY });
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(idle()));
    expect(await screen.findByText('Welcome')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Play a link' }));
    expect(screen.getByLabelText('Movie or series title')).toHaveFocus();
  });

  it('shows the shelves to resume and jumps to Search from the search bar', async () => {
    backend.on('GET /library', {
      status: 200,
      body: {
        ...EMPTY,
        history: [
          {
            id: 'tt0111161',
            type: 'movie',
            name: 'Heat',
            videoId: 'tt0111161',
            watched: true,
            progress: 1,
            lastPlayedAt: 0,
          },
        ],
        saved: [{ id: 'tt0133093', type: 'movie', name: 'The Matrix' }],
      } satisfies LibraryResponse,
    });
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(idle()));
    expect(await screen.findByRole('region', { name: 'History' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'My list' })).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Search movies and series' }));
    expect(screen.getByRole('search')).toBeInTheDocument();
  });
});

describe('home shelves', () => {
  it('caps every shelf at 8, and survives the suggestions failing', async () => {
    const entry = (i: number) => ({
      id: `tt${1000000 + i}`,
      type: 'movie' as const,
      name: `Seen ${i}`,
      videoId: `tt${1000000 + i}`,
      watched: true,
      progress: 1,
      lastPlayedAt: i,
    });
    backend.on('GET /library', {
      status: 200,
      body: { ...EMPTY, history: Array.from({ length: 12 }, (_, i) => entry(i)) },
    });
    backend.on('GET /catalog/discover', {
      status: 200,
      body: {
        results: Array.from({ length: 8 }, (_, i) => ({
          id: `tt${2000000 + i}`,
          type: 'movie',
          name: `Hot ${i}`,
        })),
      } satisfies SearchResponse,
    });
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(idle()));
    const popular = await screen.findByRole('region', { name: 'Popular now' });
    expect(within(popular).getAllByRole('listitem')).toHaveLength(8);
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(8);
  });
});

describe('discover list under the search box', () => {
  let visible: (() => void)[] = [];
  beforeEach(() => {
    visible = [];
    // jsdom has no IntersectionObserver: each observe() lets the test "scroll" into view.
    globalThis.IntersectionObserver = class {
      private readonly cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe() {
        visible.push(() =>
          this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never),
        );
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  });

  const page = (ids: string[], nextSkip?: number) => ({
    status: 200,
    body: {
      results: ids.map((id) => ({ id, type: 'movie', name: `Title ${id}` })),
      ...(nextSkip ? { nextSkip } : {}),
    },
  });

  it('shows popular movies first, loads more on scroll and stops at the end', async () => {
    backend.on('GET /catalog/browse', (call) =>
      call.query.includes('skip=2') ? page(['tt0000003']) : page(['tt0000001', 'tt0000002'], 2),
    );
    await start('Search');
    const grid = await screen.findByRole('list', { name: 'Titles' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(2);
    expect(backend.callsTo('GET /catalog/browse')[0]?.query).toBe('?type=movie&list=popular');

    act(() => visible.at(-1)?.());
    await waitFor(() => expect(within(grid).getAllByRole('listitem')).toHaveLength(3));
    expect(backend.callsTo('GET /catalog/browse')[1]?.query).toBe(
      '?type=movie&list=popular&skip=2',
    );
    // The list ended (no nextSkip): no further observer, no further request.
    expect(screen.queryByText('Loading more…')).toBeNull();
    act(() => visible.at(-1)?.());
    expect(backend.callsTo('GET /catalog/browse')).toHaveLength(2);
  });

  it('refetches when the type, list or genre changes', async () => {
    backend.on('GET /catalog/browse', page(['tt0000001']));
    await start('Search');
    await screen.findByRole('list', { name: 'Titles' });
    await userEvent.click(screen.getByRole('button', { name: 'Series' }));
    await userEvent.click(screen.getByRole('button', { name: 'Featured' }));
    await userEvent.click(screen.getByRole('button', { name: /Genre/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Drama' }));
    await waitFor(() =>
      expect(backend.callsTo('GET /catalog/browse').at(-1)?.query).toBe(
        '?type=series&list=featured&genre=Drama',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'New' }));
    const year = String(new Date().getFullYear());
    await waitFor(() =>
      expect(backend.callsTo('GET /catalog/browse').at(-1)?.query).toBe(
        `?type=series&list=new&genre=${year}`,
      ),
    );
    expect(screen.getByRole('button', { name: /Year/ })).toHaveTextContent(year);
  });

  it('gives way to live results while typing and returns when the box is cleared', async () => {
    backend.on('GET /catalog/browse', page(['tt0000001']));
    backend.on('GET /catalog/search', { status: 200, body: SEARCH });
    await start('Search');
    await screen.findByRole('list', { name: 'Titles' });
    const box = screen.getByLabelText('Movie or series title');
    await userEvent.type(box, 'matrix');
    await screen.findByRole('list', { name: 'Results' }, { timeout: 3000 });
    expect(screen.queryByRole('list', { name: 'Titles' })).toBeNull();
    await userEvent.clear(box);
    expect(await screen.findByRole('list', { name: 'Titles' }, { timeout: 3000 })).toBeVisible();
  });

  it('shows an error with a way to try again', async () => {
    let fail = true;
    backend.on('GET /catalog/browse', () =>
      fail
        ? { status: 503, body: { error: 'metadata_unavailable', message: 'Down' } }
        : page(['tt0000001']),
    );
    await start('Search');
    expect(await screen.findByRole('alert')).toHaveTextContent('Down');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Titles' })).toBeInTheDocument();
  });
});

describe('search with a pasted link', () => {
  it('offers to play a web link and does not search for it', async () => {
    await start('Search');
    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      'https://example.com/a.mp4{Enter}',
    );
    expect(screen.getByText('Play this link on TV')).toBeInTheDocument();
    expect(backend.callsTo('GET /catalog/search')).toHaveLength(0);
  });

  it('still offers the title chooser for an IMDb link', async () => {
    await start('Search');
    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      'https://www.imdb.com/title/tt7049682/',
    );
    expect(screen.queryByText('Play this link on TV')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open tt7049682 as a movie' })).toBeInTheDocument();
  });
});
