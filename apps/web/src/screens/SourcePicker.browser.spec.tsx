import type { BrowserSession, StreamOption, StreamsResponse } from '@home-media-cast/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { playTarget } from '../state/play-target.js';
import { FakeBackend, idle } from '../testing/fake-backend.js';
import { renderApp } from '../testing/render.js';

// The picker reads what this browser can decode; jsdom decodes nothing.
vi.mock('../state/device-caps.js', () => ({
  deviceCaps: () => ({
    h264: true,
    hevc: false,
    hevc10: false,
    vp9: true,
    av1: false,
    hdr: false,
  }),
}));
vi.mock('hls.js', () => ({ default: { isSupported: () => false } }));

let backend: FakeBackend;
beforeEach(() => {
  auth.clear();
  auth.set('TOKEN123');
  localStorage.clear();
  playTarget.reload();
  backend = new FakeBackend().install();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  auth.clear();
  localStorage.clear();
  playTarget.reload();
});

const option = (
  over: Partial<StreamOption> & Pick<StreamOption, 'id' | 'title'>,
): StreamOption => ({ kind: 'direct_url', cached: true, playable: true, ...over });

const OPTIONS: StreamsResponse = {
  options: [
    option({
      id: 'a',
      title: 'Movie.H264.mkv',
      video: { codec: 'h264', height: 1080, hdr: 'none' },
    }),
    option({
      id: 'b',
      title: 'Movie.HEVC.mkv',
      video: { codec: 'hevc', height: 2160, hdr: 'none' },
    }),
    option({ id: 'c', title: 'Movie.Unknown.mkv' }),
    option({
      id: 'd',
      title: 'Movie.HEVC1080.mkv',
      video: { codec: 'hevc', height: 1080, bitDepth: 10, hdr: 'none' },
    }),
  ],
  sourceErrors: [],
  fetchedAt: 1_700_000_000_000,
  refreshing: false,
};

const SESSION: BrowserSession = {
  id: 'sess1',
  handoffId: 'handoff1',
  autoNext: true,
  run: { n: 1, startMs: 0, playlistPath: '/media/sess1/1/index.m3u8' },
  durationMs: 7_200_000,
  mode: 'copy',
  audioTracks: [],
  subtitleTracks: [],
};

const open = async (waitFor_ = 'Movie.H264.mkv', streams: StreamsResponse = OPTIONS) => {
  backend.on('GET /library', {
    status: 200,
    body: {
      continueWatching: [],
      favorites: [{ id: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption' }],
      saved: [],
      history: [],
    },
  });
  backend.on('GET /catalog/movie/tt0111161', {
    status: 200,
    body: {
      id: 'tt0111161',
      type: 'movie',
      name: 'The Shawshank Redemption',
      year: '1994',
      genres: [],
      cast: [],
      state: { liked: false, saved: false },
      watched: false,
      episodes: [],
    },
  });
  backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: streams });
  const app = await renderApp();
  await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
  act(() => backend.pushStatus(idle()));
  await userEvent.click(screen.getByRole('tab', { name: 'Library' }));
  await userEvent.click(await screen.findByRole('button', { name: /The Shawshank Redemption/ }));
  await screen.findByRole('region', { name: 'Sources' });
  await screen.findByText(waitFor_);
  return app;
};

describe('open in player', () => {
  const EXTERNAL = {
    id: 'ext1',
    handoffId: 'h',
    path: '/media/ext1/file/Movie.HEVC.mkv',
    startMs: 0,
    durationMs: 7_200_000,
  };

  it('offers it as the way to watch a "TV only" row, and as a second action on the others', async () => {
    backend.on('GET /browser-play/config', { status: 200, body: { transcode: true } });
    await open();
    expect(screen.queryByRole('button', { name: 'Open in player' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    // One per playable row: the 4K one cannot play here, so this is the way to watch it.
    expect(await screen.findAllByRole('button', { name: 'Open in player' })).toHaveLength(4);
    expect(screen.getByRole('button', { name: /Movie\.HEVC\.mkv/ })).toBeDisabled();
  });

  it('asks the server for an external session and shows a link to tap if the launch is refused', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android 14');
    backend.on('POST /browser-play/external', { status: 201, body: EXTERNAL });
    await open();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    const row = screen.getByRole('button', { name: /Movie\.HEVC\.mkv/ }).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Open in player' }));

    await waitFor(() => expect(backend.callsTo('POST /browser-play/external')).toHaveLength(1));
    expect(backend.callsTo('POST /browser-play/external')[0]?.body).toEqual({
      optionId: 'b',
      title: { type: 'movie', id: 'tt0111161' },
    });
    // jsdom has no player: the link stays on screen for a second tap.
    expect(await screen.findByText('If the player did not open, tap here:')).toBeInTheDocument();
    expect(backend.callsTo('POST /browser-play')).toHaveLength(0);
  });

  it('where no player can be opened (Windows), copies the link and downloads nothing', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }));
    backend.on('POST /browser-play/external', { status: 201, body: EXTERNAL });
    await open();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    const row = screen.getByRole('button', { name: /Movie\.HEVC\.mkv/ }).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Open in player' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/api/media/')),
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByText('If the player did not open, tap here:')).not.toBeInTheDocument();
  });

  it('on Linux, offers the helper link and copies the address in case the helper is missing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    backend.on('POST /browser-play/external', { status: 201, body: EXTERNAL });
    await open();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    const row = screen.getByRole('button', { name: /Movie\.HEVC\.mkv/ }).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Open in player' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/api/media/ext1/file/')),
    );
    const tap = await screen.findByRole('link', { name: 'Open in player' });
    expect(tap.getAttribute('href')).toMatch(/^hmc-vlc:\/\/open\?url=/);
    expect(screen.getByRole('link', { name: 'Download VLC playlist' })).toHaveAttribute(
      'download',
      'video.xspf',
    );
  });

  it('asks again before opening a source that is not cached', async () => {
    backend.on('POST /browser-play/external', { status: 201, body: EXTERNAL });
    await open('Movie.Uncached.mkv', {
      ...OPTIONS,
      options: [option({ id: 'u', title: 'Movie.Uncached.mkv', cached: false })],
    });
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open in player' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Not cached/);
    expect(backend.callsTo('POST /browser-play/external')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Open in player' }));
    await waitFor(() => expect(backend.callsTo('POST /browser-play/external')).toHaveLength(1));
  });
});

describe('play target', () => {
  it('defaults to the TV and remembers the switch for this device', async () => {
    await open();
    const tv = screen.getByRole('radio', { name: 'TV' });
    const here = screen.getByRole('radio', { name: 'This device' });
    expect(tv).toBeChecked();
    expect(screen.getAllByText('▶ Play on TV')).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: /to the queue/ }).length).toBeGreaterThan(0);

    await userEvent.click(here);
    expect(localStorage.getItem('hmc.playTarget')).toBe('browser');
    expect(here).toBeChecked();
    // The queue is TV-only.
    expect(screen.queryByRole('button', { name: /to the queue/ })).not.toBeInTheDocument();
    await userEvent.click(tv);
    expect(localStorage.getItem('hmc.playTarget')).toBe('tv');
  });

  it('marks what this device cannot decode "TV only" and disables the row', async () => {
    await open();
    expect(screen.queryByText('TV only')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    expect(screen.getAllByText('TV only')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Movie\.HEVC\.mkv/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Movie\.H264\.mkv/ })).toBeEnabled();
    // Unknown video facts stay playable: the server reads the file when it starts.
    expect(screen.getByRole('button', { name: /Movie\.Unknown\.mkv/ })).toBeEnabled();
  });

  it('says "Will convert" for 1080p the device cannot decode, and "TV only" when the server does not convert', async () => {
    backend.on('GET /browser-play/config', { status: 200, body: { transcode: true } });
    await open();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    expect(await screen.findAllByText('Will convert')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Movie\.HEVC1080\.mkv/ })).toBeEnabled();
    // 4K is never converted.
    expect(screen.getAllByText('TV only')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Movie\.HEVC\.mkv/ })).toBeDisabled();
  });

  it('marks it "TV only" when the server has conversion switched off', async () => {
    backend.on('GET /browser-play/config', { status: 200, body: { transcode: false } });
    await open();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    await waitFor(() => expect(screen.getAllByText('TV only')).toHaveLength(2));
    expect(screen.queryByText('Will convert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Movie\.HEVC1080\.mkv/ })).toBeDisabled();
  });

  it('starts a browser session with the measured capabilities, and opens the player', async () => {
    backend.on('POST /browser-play', { status: 201, body: SESSION });
    backend.on('POST /browser-play/sess1/progress', { status: 204 });
    backend.on('DELETE /browser-play/sess1', { status: 204 });
    const { router } = await open();
    await userEvent.click(screen.getByRole('radio', { name: 'This device' }));
    await userEvent.click(screen.getByRole('button', { name: /Movie\.H264\.mkv/ }));

    expect(await screen.findByRole('dialog', { name: 'Video player' })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ sheet: 'player' });
    expect(backend.callsTo('POST /browser-play')[0]?.body).toEqual({
      optionId: 'a',
      title: { type: 'movie', id: 'tt0111161' },
      caps: { h264: true, hevc: false, hevc10: false, vp9: true, av1: false, hdr: false },
    });
    expect(backend.callsTo('POST /playback/stream')).toHaveLength(0);
  });

  it('leaves the TV flow as it was when the target is the TV', async () => {
    backend.on('POST /playback/stream', { status: 202, body: { status: 'accepted' } });
    await open();
    await userEvent.click(screen.getByRole('button', { name: /Movie\.HEVC\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /playback/stream')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/stream')[0]?.body).toEqual({
      optionId: 'b',
      title: { type: 'movie', id: 'tt0111161' },
    });
    expect(backend.callsTo('POST /browser-play')).toHaveLength(0);
  });
});
