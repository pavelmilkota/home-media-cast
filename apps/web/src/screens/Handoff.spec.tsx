import type { BrowserSession, StreamsResponse } from '@home-media-cast/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { handoffPick } from '../state/handoff-pick.js';
import { playTarget } from '../state/play-target.js';
import { FakeBackend, idle, playing } from '../testing/fake-backend.js';
import { renderApp } from '../testing/render.js';

vi.mock('../state/device-caps.js', () => ({
  deviceCaps: () => ({ h264: true, hevc: false, hevc10: false, vp9: true, av1: false, hdr: false }),
}));
vi.mock('hls.js', () => ({ default: { isSupported: () => false } }));

const SESSION: BrowserSession = {
  id: 'sess1',
  handoffId: 'own-handoff',
  autoNext: true,
  run: { n: 1, startMs: 600_000, playlistPath: '/media/sess1/1/index.m3u8' },
  durationMs: 7_200_000,
  mode: 'copy',
  audioTracks: [],
  subtitleTracks: [],
};
const FROM_TV = playing({ media: { name: 'The Movie' }, positionMs: 600_000 });

let backend: FakeBackend;
beforeEach(() => {
  auth.clear();
  auth.set('TOKEN123');
  localStorage.clear();
  playTarget.reload();
  handoffPick.set(undefined);
  backend = new FakeBackend().install();
  backend.on('GET /library', {
    status: 200,
    body: { continueWatching: [], favorites: [], saved: [], history: [] },
  });
  backend.on('POST /browser-play/sess1/started', { status: 204 });
  backend.on('POST /browser-play/sess1/progress', { status: 204 });
  backend.on('DELETE /browser-play/sess1', { status: 204 });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  auth.clear();
  localStorage.clear();
  handoffPick.set(undefined);
});

const open = async (status = FROM_TV) => {
  const app = await renderApp();
  await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
  act(() => backend.pushStatus(status));
  return app;
};
/** Events one after another, as the server sends them: a render lands between two of them. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
const sendToTvFromMenu = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Send to TV' }));
};
const here = () => screen.queryByRole('button', { name: 'Continue here' });

describe('Continue here', () => {
  it('is offered only when the TV plays something chosen from the catalog', async () => {
    await open(playing()); // a pasted link or YouTube: no catalog context
    await screen.findByRole('button', { name: /Now playing/ });
    expect(here()).not.toBeInTheDocument();

    act(() => backend.pushStatus(FROM_TV));
    expect(await screen.findByRole('button', { name: 'Continue here' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Now playing/ }));
    // The sheet has its own button (the mini-player behind it is hidden from the tree).
    expect(
      (await screen.findAllByRole('button', { name: 'Continue here' })).length,
    ).toBeGreaterThan(0);
  });

  it('takes the session, opens the player at its position, and says it plays', async () => {
    backend.on('POST /playback/handoff/here', { status: 201, body: SESSION });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here' }));

    expect(await screen.findByRole('dialog', { name: 'Video player' })).toBeInTheDocument();
    expect(screen.getAllByText('The Movie').length).toBeGreaterThan(0);
    expect(backend.callsTo('POST /playback/handoff/here')[0]?.body).toEqual({
      caps: { h264: true, hevc: false, hevc10: false, vp9: true, av1: false, hdr: false },
    });
    // The TV is stopped by the server only after the player reports it plays.
    expect(backend.callsTo('POST /browser-play/sess1/started')).toHaveLength(0);
    const video = document.querySelector('video')!;
    fireEvent.playing(video);
    fireEvent.playing(video);
    await waitFor(() =>
      expect(backend.callsTo('POST /browser-play/sess1/started')).toHaveLength(1),
    );
  });
});

describe('a browser playing on another device', () => {
  const laptop = {
    active: true as const,
    deviceId: 'd2',
    deviceName: 'Laptop',
    media: { name: 'The Movie' },
    positionMs: 90_000,
    durationMs: 7_200_000,
    handoffId: 'other-handoff',
  };

  it('shows where it plays, with Continue here and Send to TV', async () => {
    backend.on('POST /playback/handoff/tv', { status: 204 });
    await open(idle());
    act(() => backend.push({ type: 'browser', data: laptop }));
    expect(await screen.findByText('Playing on Laptop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue here' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send to TV' }));
    await waitFor(() => expect(backend.callsTo('POST /playback/handoff/tv')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/handoff/tv')[0]?.body).toEqual({});
  });

  it('goes away when that session ends', async () => {
    await open(idle());
    act(() => backend.push({ type: 'browser', data: laptop }));
    await screen.findByText('Playing on Laptop');
    act(() => backend.push({ type: 'browser', data: { active: false } }));
    await waitFor(() => expect(screen.queryByText('Playing on Laptop')).not.toBeInTheDocument());
  });
});

describe('when this player is taken', () => {
  const takeOver = async () => {
    backend.on('POST /playback/handoff/here', { status: 201, body: SESSION });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here' }));
    await screen.findByRole('dialog', { name: 'Video player' });
    act(() => backend.pushStatus(idle()));
    await settle();
    act(() =>
      backend.push({
        type: 'browser',
        data: {
          active: true,
          deviceId: 'd1',
          deviceName: 'Phone',
          positionMs: 600_000,
          durationMs: 7_200_000,
          handoffId: 'own-handoff',
        },
      }),
    );
    await settle();
  };

  it('closes with a toast naming the other browser', async () => {
    await takeOver();
    act(() =>
      backend.push({
        type: 'browser',
        data: {
          active: true,
          deviceId: 'd2',
          deviceName: 'Laptop',
          positionMs: 0,
          durationMs: 7_200_000,
          handoffId: 'new-handoff',
        },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Video player' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Now playing on Laptop')).toBeInTheDocument();
  });

  it('closes with a toast naming the TV when the TV takes it', async () => {
    await takeOver();
    act(() => backend.pushStatus(playing({ media: { name: 'The Movie' } })));
    act(() => backend.push({ type: 'browser', data: { active: false } }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Video player' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Now playing on the TV')).toBeInTheDocument();
  });

  it('does nothing before the server has shown this session as the household’s', async () => {
    backend.on('POST /playback/handoff/here', { status: 201, body: SESSION });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here' }));
    await screen.findByRole('dialog', { name: 'Video player' });
    act(() => backend.push({ type: 'browser', data: { active: false } }));
    act(() => backend.pushStatus(playing({ media: { name: 'The Movie' } })));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('dialog', { name: 'Video player' })).toBeInTheDocument();
  });
});

describe('Send to TV from the player', () => {
  it('sends the position of the player', async () => {
    backend.on('POST /playback/handoff/here', { status: 201, body: SESSION });
    backend.on('POST /playback/handoff/tv', { status: 204 });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here' }));
    await screen.findByRole('dialog', { name: 'Video player' });
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 30, configurable: true });
    fireEvent.timeUpdate(video);
    await sendToTvFromMenu();
    await waitFor(() => expect(backend.callsTo('POST /playback/handoff/tv')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/handoff/tv')[0]?.body).toEqual({ positionMs: 630_000 });
  });
});

describe('when the server cannot pick the source', () => {
  const OPTIONS: StreamsResponse = {
    options: [
      { id: 'a', title: 'Movie.H264.mkv', kind: 'direct_url', cached: true, playable: true },
    ],
    sourceErrors: [],
    fetchedAt: 1_700_000_000_000,
    refreshing: false,
  };
  const titleRoutes = () => {
    backend.on('GET /catalog/movie/tt0111161', {
      status: 200,
      body: {
        id: 'tt0111161',
        type: 'movie',
        name: 'The Movie',
        genres: [],
        cast: [],
        state: { liked: false, saved: false },
        watched: false,
        episodes: [],
      },
    });
    backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: OPTIONS });
  };

  it('Continue here opens the picker for the title, to start there in this browser', async () => {
    titleRoutes();
    backend.on('POST /playback/handoff/here', {
      status: 409,
      body: {
        error: 'handoff_pick_source',
        message: 'This device cannot play 2160p video',
        pick: { type: 'movie', videoId: 'tt0111161', positionMs: 600_000 },
      },
    });
    backend.on('POST /browser-play', { status: 201, body: SESSION });
    const { router } = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/title/movie/tt0111161'));
    expect(
      await screen.findByText('Pick the source to continue here from 10:00.'),
    ).toBeInTheDocument();
    expect(screen.getByText('This device cannot play 2160p video')).toBeInTheDocument();
    expect(backend.callsTo('POST /playback/handoff/here')).toHaveLength(1);

    await userEvent.click(await screen.findByRole('button', { name: /Movie\.H264\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /browser-play')).toHaveLength(1));
    expect(backend.callsTo('POST /browser-play')[0]?.body).toMatchObject({
      optionId: 'a',
      startMs: 600_000,
    });
    // The TV was not touched by the failed handoff.
    expect(backend.callsTo('POST /player/stop')).toHaveLength(0);
  });

  it('Send to TV opens the picker, which plays on the TV', async () => {
    titleRoutes();
    backend.on('POST /playback/handoff/tv', {
      status: 409,
      body: {
        error: 'handoff_pick_source',
        message: 'Pick a source for this title to continue',
        pick: { type: 'movie', videoId: 'tt0111161', positionMs: 600_000 },
      },
    });
    backend.on('POST /playback/stream', { status: 202, body: { status: 'accepted' } });
    backend.on('POST /playback/handoff/here', { status: 201, body: SESSION });
    const { router } = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here' }));
    await screen.findByRole('dialog', { name: 'Video player' });
    await sendToTvFromMenu();

    await waitFor(() => expect(router.state.location.pathname).toBe('/title/movie/tt0111161'));
    expect(
      await screen.findByText('Pick the source to continue on the TV from 10:00.'),
    ).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Movie\.H264\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /playback/stream')).toHaveLength(1));
    expect(backend.callsTo('POST /browser-play')).toHaveLength(0);
  });
});
