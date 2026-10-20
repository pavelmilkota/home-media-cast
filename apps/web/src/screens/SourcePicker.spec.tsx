import type { StreamOption, StreamsResponse, TitleDetail } from '@home-media-cast/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { FakeBackend, idle, playing } from '../testing/fake-backend.js';
import { renderApp } from '../testing/render.js';

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

const option = (
  over: Partial<StreamOption> & Pick<StreamOption, 'id' | 'title'>,
): StreamOption => ({
  kind: 'direct_url',
  cached: true,
  playable: true,
  ...over,
});

const OPTIONS: StreamsResponse = {
  options: [
    option({
      id: 'a',
      title: 'Movie.1080p.mkv',
      service: 'realdebrid',
      sizeBytes: 3.5e9,
      languages: ['Ukrainian', 'English'],
      resolution: '1080p',
    }),
    option({
      id: 'b',
      title: 'Movie.2160p.mkv',
      service: 'torbox',
      sizeBytes: 12e9,
      cached: false,
    }),
    option({
      id: 'c',
      title: 'Usenet release',
      kind: 'unsupported',
      cached: null,
      playable: false,
      reason: 'Unsupported source type (nzbUrl)',
    }),
  ],
  sourceErrors: ['[❌] AIOSubtitle'],
  fetchedAt: 1_700_000_000_000,
  refreshing: false,
};

const MOVIE: TitleDetail = {
  id: 'tt0111161',
  type: 'movie',
  name: 'The Shawshank Redemption',
  year: '1994',
  genres: ['Drama'],
  cast: [],
  state: { liked: false, saved: false },
  watched: false,
  episodes: [],
};

/** Opens the movie's title page from the Library tab; the source search starts by itself. */
const open = async () => {
  backend.on('GET /library', {
    status: 200,
    body: {
      continueWatching: [],
      favorites: [{ id: 'tt0111161', type: 'movie', name: MOVIE.name }],
      saved: [],
      history: [],
    },
  });
  backend.on('GET /catalog/movie/tt0111161', { status: 200, body: MOVIE });
  await renderApp();
  await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
  act(() => backend.pushStatus(idle()));
  await userEvent.click(screen.getByRole('tab', { name: 'Library' }));
  await userEvent.click(await screen.findByRole('button', { name: /The Shawshank Redemption/ }));
};
const search = async () => {
  await screen.findByRole('region', { name: 'Sources' });
};
describe('find a source', () => {
  it('lists the sources with their details, never a URL', async () => {
    backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: OPTIONS });
    await open();
    await search();
    expect(await screen.findByText('Movie.1080p.mkv')).toBeInTheDocument();
    // Languages and resolution come first, under the title.
    expect(screen.getByText('Ukrainian, English')).toBeInTheDocument();
    expect(screen.getByText('TorBox')).toBeInTheDocument();
    expect(screen.getByText('12 GB')).toBeInTheDocument();
    expect(screen.getByText('not cached')).toBeInTheDocument();
    expect(screen.getByText(/Some sources failed: \[❌\] AIOSubtitle/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Usenet release/ })).toBeDisabled();
    expect(screen.getByText(/Unsupported source type \(nzbUrl\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/https?:\/\//);
  });

  it('plays a cached source and stays on the title page once Kodi is playing', async () => {
    backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: OPTIONS });
    backend.on('POST /playback/stream', { status: 202, body: { status: 'accepted' } });
    await open();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Movie\.1080p\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /playback/stream')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/stream')[0]?.body).toEqual({
      optionId: 'a',
      title: { type: 'movie', id: 'tt0111161' },
    });
    expect(await screen.findByText('Waiting for the TV to start the video…')).toBeInTheDocument();
    act(() => backend.pushStatus(playing()));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    // Starting playback stays on the title page.
    expect(screen.queryByText('Waiting for the TV to start the video…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back/ })).toBeInTheDocument();
  });

  it('asks for a second tap before an uncached source, which can start a download', async () => {
    backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: OPTIONS });
    backend.on('POST /playback/stream', { status: 202, body: { status: 'accepted' } });
    await open();
    await search();
    const uncached = await screen.findByRole('button', { name: /Movie\.2160p\.mkv/ });
    await userEvent.click(uncached);
    expect(screen.getByRole('alert')).toHaveTextContent('may start a download');
    expect(backend.callsTo('POST /playback/stream')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: /Movie\.2160p\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /playback/stream')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/stream')[0]?.body).toEqual({
      optionId: 'b',
      title: { type: 'movie', id: 'tt0111161' },
    });
  });

  it('says so when the TV does not start the video', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: OPTIONS });
    backend.on('POST /playback/stream', { status: 202, body: { status: 'accepted' } });
    await open();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Movie\.1080p\.mkv/ }));
    await screen.findByText('Waiting for the TV to start the video…');
    await act(async () => void (await vi.advanceTimersByTimeAsync(26_000)));
    expect(await screen.findByText(/did not start the video/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Movie\.1080p\.mkv/ })).toBeEnabled();
    vi.useRealTimers();
  });

  it.each([
    [503, 'The stream source is not available right now'],
    [503, 'No stream source is configured'],
  ])('shows why a search failed (%i)', async (status, message) => {
    backend.on('GET /titles/movie/tt0111161/streams', { status, body: { message } });
    await open();
    await search();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('drops an out-of-date list when the server no longer knows the source (410)', async () => {
    backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: OPTIONS });
    backend.on('POST /playback/stream', {
      status: 410,
      body: {
        error: 'option_expired',
        message: 'This source is no longer available; search again',
      },
    });
    await open();
    await search();
    await userEvent.click(await screen.findByRole('button', { name: /Movie\.1080p\.mkv/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available; search again');
    // The list is fetched again for the new ids.
    await waitFor(() =>
      expect(backend.callsTo('GET /titles/movie/tt0111161/streams')).toHaveLength(2),
    );
  });

  it('queues a source without playing it', async () => {
    backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: OPTIONS });
    backend.on('POST /queue', {
      status: 201,
      body: { id: 'q1', type: 'movie', videoId: 'tt0111161', name: MOVIE.name },
    });
    await open();
    await search();
    expect(screen.queryByRole('button', { name: 'Add source 3 to the queue' })).toBeNull(); // not playable
    await userEvent.click(await screen.findByRole('button', { name: 'Add source 1 to the queue' }));
    expect(await screen.findByText(/Added to the queue/)).toBeInTheDocument();
    expect(backend.callsTo('POST /queue')[0]?.body).toEqual({
      optionId: 'a',
      title: { type: 'movie', id: 'tt0111161' },
    });
    expect(backend.callsTo('POST /playback/stream')).toHaveLength(0);
  });
});

describe('cached list', () => {
  const STREAMS = 'GET /titles/movie/tt0111161/streams';
  const fresh = (title: string): StreamsResponse => ({
    ...OPTIONS,
    options: [option({ id: 'n', title })],
    fetchedAt: Date.now(),
    refreshing: false,
  });

  it('shows no status line for a settled response', async () => {
    backend.on(STREAMS, { status: 200, body: OPTIONS });
    await open();
    await search();
    await screen.findByText('Movie.1080p.mkv');
    expect(screen.queryByText(/Updating/)).toBeNull();
    expect(screen.queryByText(/Could not update/)).toBeNull();
  });

  it('shows the cached list at once with an updating line, then swaps it when the update lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    backend.on(STREAMS, () => {
      polls++;
      return polls === 1
        ? {
            status: 200,
            body: { ...OPTIONS, fetchedAt: Date.now() - 3 * 3_600_000, refreshing: true },
          }
        : { status: 200, body: fresh('Brand.new.mkv') };
    });
    await open();
    await search();
    expect(await screen.findByText('Movie.1080p.mkv')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Updating… showing results from 3 h ago');
    await act(async () => void (await vi.advanceTimersByTimeAsync(2_100)));
    expect(await screen.findByText('Brand.new.mkv')).toBeInTheDocument();
    expect(screen.queryByText('Movie.1080p.mkv')).toBeNull();
    expect(screen.queryByText(/Updating/)).toBeNull();
    // No further polling once the update is done.
    await act(async () => void (await vi.advanceTimersByTimeAsync(6_000)));
    expect(polls).toBe(2);
    vi.useRealTimers();
  });

  it('keeps the list and offers Retry, which asks the server to update (refresh=1)', async () => {
    backend.on(STREAMS, (call) =>
      call.query.includes('refresh=1')
        ? { status: 200, body: fresh('Retried.mkv') }
        : {
            status: 200,
            body: {
              ...OPTIONS,
              fetchedAt: Date.now() - 2 * 24 * 3_600_000,
              refreshError: 'AIOStreams is not reachable',
            },
          },
    );
    await open();
    await search();
    expect(await screen.findByText('Movie.1080p.mkv')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Could not update · results from 2 d ago');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retried.mkv')).toBeInTheDocument();
    expect(backend.callsTo(STREAMS).at(-1)?.query).toBe('?refresh=1');
    expect(screen.queryByText(/Could not update/)).toBeNull();
  });
});

describe('queue on Home', () => {
  it('shows what is waiting and removes an entry', async () => {
    let items = [
      { id: 'q1', type: 'series', videoId: 'tt1:1:2', name: 'Some Show', label: 'S1E2 · Two' },
      { id: 'q2', type: 'movie', videoId: 'tt0111161', name: 'Heat' },
    ];
    backend.on('GET /queue', () => ({ status: 200, body: { items } }));
    backend.on('DELETE /queue/q1', () => {
      items = items.slice(1);
      return { status: 204 };
    });
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(idle()));
    expect(await screen.findByText('Up next')).toBeInTheDocument();
    expect(screen.getByText(/S1E2 · Two/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Some Show from the queue' }));
    await waitFor(() => expect(screen.queryByText(/S1E2 · Two/)).toBeNull());
    expect(screen.getByText('Heat')).toBeInTheDocument();
  });

  it('shows nothing when the queue is empty', async () => {
    backend.on('GET /queue', { status: 200, body: { items: [] } });
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(idle()));
    await screen.findByRole('button', { name: 'Search movies and series' });
    expect(screen.queryByText('Up next')).toBeNull();
  });
});
