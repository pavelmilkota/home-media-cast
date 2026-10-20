import type { SearchResponse, TitleDetail } from '@home-media-cast/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from './api/auth.js';
import { validateRootSearch, validateSearchQuery } from './router.js';
import { FakeBackend, idle, playing } from './testing/fake-backend.js';
import { renderApp } from './testing/render.js';

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

const MOVIE: TitleDetail = {
  id: 'tt0111161',
  type: 'movie',
  name: 'The Shawshank Redemption',
  year: '1994',
  description: 'Two imprisoned men bond.',
  genres: [],
  cast: [],
  state: { liked: false, saved: false },
  watched: false,
  episodes: [],
};
const SEARCH: SearchResponse = {
  results: [{ id: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption', year: '1994' }],
};

const live = async (status = idle()) => {
  await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
  act(() => backend.pushStatus(status));
};
const selectedTab = () => screen.getByRole('tab', { selected: true }).textContent;

describe('validation', () => {
  it('keeps only a known sheet and a query of 2+ characters', () => {
    expect(validateRootSearch({ sheet: 'remote' })).toEqual({ sheet: 'remote' });
    expect(validateRootSearch({ sheet: 'nope' })).toEqual({});
    expect(validateSearchQuery({ q: ' ab ' })).toEqual({ q: 'ab' });
    expect(validateSearchQuery({ q: 'a' })).toEqual({});
    expect(validateSearchQuery({ q: 5 })).toEqual({});
  });
});

describe('tabs', () => {
  it('renders each tab from its URL with the matching tab selected', async () => {
    backend.on('GET /library', {
      status: 200,
      body: { continueWatching: [], favorites: [], saved: [], history: [] },
    });
    const lib = await renderApp({ url: '/library' });
    await live();
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
    expect(selectedTab()).toBe('Library');
    lib.unmount();

    await renderApp({ url: '/' });
    expect(selectedTab()).toBe('Home');
  });

  it('sends unknown paths and bad titles to Home', async () => {
    const a = await renderApp({ url: '/nope/at/all' });
    expect(a.router.state.location.pathname).toBe('/');
    a.unmount();
    const b = await renderApp({ url: '/title/bogus/x' });
    expect(b.router.state.location.pathname).toBe('/');
  });
});

describe('title and search', () => {
  beforeEach(() => {
    backend.on('GET /catalog/search', { status: 200, body: SEARCH });
    backend.on('GET /catalog/movie/tt0111161', { status: 200, body: MOVIE });
  });

  it('opens a title from its URL, with no tab selected', async () => {
    await renderApp({ url: '/title/movie/tt0111161' });
    await live();
    expect(await screen.findByText('The Shawshank Redemption')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { selected: true })).not.toBeInTheDocument();
  });

  it('Back from a title returns to the search results', async () => {
    const { router } = await renderApp({ url: '/search?q=shaw' });
    await live();
    await userEvent.click(await screen.findByText('The Shawshank Redemption'));
    expect(router.state.location.pathname).toBe('/title/movie/tt0111161');
    await userEvent.click(await screen.findByRole('button', { name: /Back/ }));
    expect(router.state.location.pathname).toBe('/search');
    expect(router.state.location.search).toEqual({ q: 'shaw' });
    expect(await screen.findByText('The Shawshank Redemption')).toBeInTheDocument();
  });

  it('Back on a directly opened title goes Home', async () => {
    const { router } = await renderApp({ url: '/title/movie/tt0111161' });
    await live();
    await userEvent.click(await screen.findByRole('button', { name: /Back/ }));
    expect(router.state.location.pathname).toBe('/');
  });

  it('submitting a search puts the query in the URL', async () => {
    const { router } = await renderApp({ url: '/search' });
    await live();
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'shaw{Enter}');
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'shaw' }));
  });
});

describe('sheets', () => {
  it('opens Settings from the URL and Back closes it in place', async () => {
    const { router } = await renderApp({ url: '/library' });
    await live();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(router.state.location.search).toEqual({ sheet: 'settings' });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    act(() => router.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/library');
    expect(router.state.location.search).toEqual({});
  });

  it('closing the sheet by hand removes the param', async () => {
    const { router } = await renderApp({ url: '/library?sheet=settings' });
    await live();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('drops a Remote link when nothing is playing, replacing the entry', async () => {
    const { router } = await renderApp({ url: '/library?sheet=remote' });
    await live();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.history.canGoBack()).toBe(false);
  });

  it('closes the Remote when playback stops, and Back does not reopen it', async () => {
    const { router } = await renderApp({ url: '/library' });
    await live(playing({ title: 'Big Buck Bunny' }));
    await userEvent.click(await screen.findByRole('button', { name: /Now playing/ }));
    expect(router.state.location.search).toEqual({ sheet: 'remote' });
    act(() => backend.pushStatus(idle()));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    act(() => router.history.back());
    expect(router.state.location.search).toEqual({});
  });
});

describe('search focus', () => {
  it('focuses the input from Home but not from the tab bar', async () => {
    await renderApp({ url: '/' });
    await live();
    await userEvent.click(screen.getByRole('button', { name: 'Search movies and series' }));
    expect(screen.getByLabelText('Movie or series title')).toHaveFocus();
    await userEvent.click(screen.getByRole('tab', { name: 'Library' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }));
    expect(screen.getByLabelText('Movie or series title')).not.toHaveFocus();
  });
});
