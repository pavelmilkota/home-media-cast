import type { BrowserSession, StreamsResponse } from '@home-media-cast/shared';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { guestProgress } from '../state/guest-progress.js';
import { LiveProvider } from '../state/live.js';
import { closePairing } from '../state/pairing-dialog.js';
import { playTarget, useEffectiveTarget } from '../state/play-target.js';
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
  run: { n: 1, startMs: 0, playlistPath: '/media/sess1/1/index.m3u8' },
  durationMs: 7_200_000,
  mode: 'copy',
  audioTracks: [],
  subtitleTracks: [],
};
const STREAMS: StreamsResponse = {
  options: [{ id: 'a', kind: 'direct_url', cached: true, playable: true, title: 'Movie.H264.mkv' }],
  sourceErrors: [],
  fetchedAt: 1_700_000_000_000,
  refreshing: false,
};
const FROM_TV = playing({ media: { name: 'The Movie' }, positionMs: 600_000 });

let backend: FakeBackend;
beforeEach(() => {
  auth.clear();
  localStorage.clear();
  playTarget.reload();
  closePairing();
  backend = new FakeBackend().install();
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
      trailer: 'abc',
      state: { liked: false, saved: false },
      watched: false,
      episodes: [],
    },
  });
  backend.on('GET /titles/movie/tt0111161/streams', { status: 200, body: STREAMS });
  backend.on('POST /browser-play', { status: 201, body: SESSION });
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
  playTarget.reload();
  closePairing();
});

const asGuest = () => auth.set('GUEST1', 'guest');
const start = async () => {
  const app = await renderApp();
  await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
  act(() => backend.pushStatus(idle()));
  return app;
};
const openTitle = async () => {
  await userEvent.click(screen.getByRole('tab', { name: 'Library' }));
  await userEvent.click(await screen.findByRole('button', { name: /The Shawshank Redemption/ }));
  await screen.findByRole('region', { name: 'Sources' });
};
const sendToTvFromMenu = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Send to TV' }));
};
const pairingOpen = () => screen.queryByRole('dialog', { name: 'Pair with the TV' });

describe('the TV gate', () => {
  it('opens pairing for a guest when Kodi is connected, on each paired-only control', async () => {
    asGuest();
    await start();
    act(() => backend.pushKodi({ state: 'connected', version: '13.5.0' }));
    act(() => backend.pushStatus(FROM_TV));

    // Mini player: Pause and Here go through the gate, and so does tapping it.
    for (const name of ['Pause', 'Continue here', /^Now playing/] as const) {
      await userEvent.click(await screen.findByRole('button', { name }));
      expect(await screen.findByRole('dialog', { name: 'Pair with the TV' })).toBeInTheDocument();
      act(() => closePairing());
      await waitFor(() => expect(pairingOpen()).not.toBeInTheDocument());
    }
    expect(screen.queryByRole('dialog', { name: 'Remote' })).not.toBeInTheDocument();

    // Title page: like, save, trailer and watched.
    act(() => backend.pushStatus(idle()));
    await userEvent.click(screen.getByRole('tab', { name: 'Library' }));
    await userEvent.click(await screen.findByRole('button', { name: /The Shawshank Redemption/ }));
    for (const name of [/Like/, /My list/, /Trailer/, /Mark watched/]) {
      await userEvent.click(await screen.findByRole('button', { name }));
      expect(await screen.findByRole('dialog', { name: 'Pair with the TV' })).toBeInTheDocument();
      act(() => closePairing());
      await waitFor(() => expect(pairingOpen()).not.toBeInTheDocument());
    }
    expect(backend.callsTo('PUT /catalog/movie/tt0111161/state')).toHaveLength(0);
    expect(backend.callsTo('POST /catalog/movie/tt0111161/trailer')).toHaveLength(0);
  }, 20_000);

  it('disables them when Kodi is down, because pairing needs Kodi', async () => {
    asGuest();
    await start();
    act(() => backend.pushKodi({ state: 'reconnecting' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Library' }));
    await userEvent.click(await screen.findByRole('button', { name: /The Shawshank Redemption/ }));
    for (const name of [/Like/, /My list/, /Trailer/, /Mark watched/]) {
      expect(await screen.findByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getAllByText(/Kodi to be running/).length).toBeGreaterThan(0);
    // The TV segment of "Play on" is disabled too, and the guest plays here.
    expect(await screen.findByRole('radio', { name: 'TV' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'This device' })).toBeChecked();
  });

  it('shows a guest the TV status, with the controls disabled when Kodi is down', async () => {
    asGuest();
    await start();
    act(() => backend.pushKodi({ state: 'reconnecting' }));
    act(() => backend.pushStatus(FROM_TV));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue here' })).toBeDisabled();
  });

  it('leaves a paired device alone with the target on TV and Kodi up', async () => {
    auth.set('PAIRED1', 'paired');
    localStorage.setItem('hmc.playTarget', 'tv');
    playTarget.reload();
    backend.on('POST /player/pause', { status: 204 });
    await start();
    act(() => backend.pushKodi({ state: 'connected', version: '13.5.0' }));
    act(() => backend.pushStatus(FROM_TV));
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(backend.callsTo('POST /player/pause')).toHaveLength(1));
    expect(pairingOpen()).not.toBeInTheDocument();
  });
});

describe('what a guest asks for', () => {
  it('sends no queue, cache, device or YouTube requests', async () => {
    asGuest();
    await start();
    await openTitle();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    // Language, theme, external player and a Pair card; none of the household's or the TV's.
    expect(screen.getByRole('button', { name: 'Pair with the TV' })).toBeInTheDocument();
    expect(screen.queryByText('Logs')).not.toBeInTheDocument();
    expect(screen.queryByText('Paired devices')).not.toBeInTheDocument();
    expect(screen.queryByText('Restart Kodi')).not.toBeInTheDocument();
    const paths = backend.calls.map((c) => c.path);
    for (const forbidden of ['/queue', '/streams/cache', '/devices', '/youtube', '/player/']) {
      expect(paths.filter((p) => p.startsWith(forbidden))).toEqual([]);
    }
  });

  it('a paired device does ask for them', async () => {
    auth.set('PAIRED1', 'paired');
    backend.on('GET /queue', { status: 200, body: { items: [] } });
    backend.on('GET /devices', { status: 200, body: [] });
    await start();
    await openTitle();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    const paths = backend.calls.map((c) => c.path);
    expect(paths).toContain('/queue');
    expect(paths).toContain('/devices');
  });
});

describe('pairing from the player', () => {
  const playAsGuest = async () => {
    asGuest();
    const app = await start();
    await openTitle();
    await userEvent.click(await screen.findByRole('button', { name: /Movie\.H264\.mkv/ }));
    await screen.findByRole('dialog', { name: 'Video player' });
    return app;
  };

  it('keeps the session and ?sheet=player, a wrong code leaves everything alone, then Send to TV works', async () => {
    backend.on('POST /pairing/start', { status: 200, body: { expiresInSeconds: 300 } });
    backend.on('POST /pairing/complete', (call) =>
      (call.body as { code: string }).code === '123456'
        ? { status: 200, body: { deviceId: 'g1', token: 'PAIREDNOW' } }
        : { status: 401, body: { message: 'Invalid or expired code' } },
    );
    backend.on('POST /playback/handoff/tv', { status: 204 });
    const app = await playAsGuest();
    expect(app.router.state.location.search).toMatchObject({ sheet: 'player' });

    // Send to TV is paired-only: a guest is sent to pairing, and no request goes out.
    await sendToTvFromMenu();
    const dialog = await screen.findByRole('dialog', { name: 'Pair with the TV' });
    expect(backend.callsTo('POST /playback/handoff/tv')).toHaveLength(0);
    expect(app.router.state.location.search).toMatchObject({ sheet: 'player' });

    // A wrong code answers 401, which must not log the guest out or end the film.
    const code = dialog.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await userEvent.type(code, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText('Invalid or expired code')).toBeInTheDocument();
    expect(auth.get()).toBe('GUEST1');
    expect(auth.kind()).toBe('guest');
    // (Hidden from the accessibility tree while the sheet is modal, but still mounted.)
    expect(screen.getByRole('dialog', { name: 'Video player', hidden: true })).toBeInTheDocument();
    expect(backend.callsTo('DELETE /browser-play/sess1')).toHaveLength(0);
    // The guest bearer went along with the request.
    expect(backend.callsTo('POST /pairing/complete')[0]?.authorization).toBe('Bearer GUEST1');

    // The right one pairs this very device, and the player is still there.
    await userEvent.clear(code);
    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(auth.get()).toBe('PAIREDNOW'));
    expect(auth.kind()).toBe('paired');
    await waitFor(() => expect(pairingOpen()).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Video player' })).toBeInTheDocument();
    expect(app.router.state.location.search).toMatchObject({ sheet: 'player' });
    expect(backend.callsTo('DELETE /browser-play/sess1')).toHaveLength(0);

    // Send to TV now works, with the new token.
    await sendToTvFromMenu();
    await waitFor(() => expect(backend.callsTo('POST /playback/handoff/tv')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/handoff/tv')[0]?.authorization).toBe('Bearer PAIREDNOW');
  });

  it('remembers where a guest got to, in its own browser', async () => {
    await playAsGuest();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 90, configurable: true });
    fireEvent.timeUpdate(video);
    fireEvent.pause(video);
    await waitFor(() => expect(guestProgress.get('tt0111161')?.positionMs).toBe(90_000));
    expect(guestProgress.get('tt0111161')?.durationMs).toBe(7_200_000);
  });
});

describe('a guest resumes from its own progress', () => {
  it('offers it in the picker and sends it as startMs unless the switch is off', async () => {
    guestProgress.save('tt0111161', 1_800_000, 7_200_000);
    asGuest();
    await start();
    await openTitle();
    expect(screen.getByText(/Resume where I stopped \(25%\)/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Movie\.H264\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /browser-play')).toHaveLength(1));
    expect(backend.callsTo('POST /browser-play')[0]?.body).toMatchObject({ startMs: 1_800_000 });
    expect(backend.callsTo('POST /browser-play')[0]?.authorization).toBe('Bearer GUEST1');
  });

  it('does not send it when the resume switch is off', async () => {
    guestProgress.save('tt0111161', 1_800_000, 7_200_000);
    asGuest();
    await start();
    await openTitle();
    await userEvent.click(screen.getByRole('switch'));
    await userEvent.click(await screen.findByRole('button', { name: /Movie\.H264\.mkv/ }));
    await waitFor(() => expect(backend.callsTo('POST /browser-play')).toHaveLength(1));
    const body = backend.callsTo('POST /browser-play')[0]?.body as Record<string, unknown>;
    expect(body['startMs']).toBeUndefined();
    expect(body['resume']).toBe(false);
  });
});

describe('the effective play target', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveProvider token="T">{children}</LiveProvider>
  );
  const target = () => renderHook(() => useEffectiveTarget(), { wrapper });
  const kodi = (state: 'connected' | 'reconnecting') =>
    act(() => backend.pushKodi({ state, version: '13.5.0' }));

  it('is this device for a guest, whatever was stored', async () => {
    asGuest();
    localStorage.setItem('hmc.playTarget', 'tv');
    playTarget.reload();
    const { result } = target();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    kodi('connected');
    expect(result.current).toBe('browser');
  });

  it('with no choice is the TV while Kodi is up (or unknown) and this device while it is down', async () => {
    auth.set('PAIRED1', 'paired');
    const { result } = target();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    expect(result.current).toBe('tv');
    kodi('connected');
    expect(result.current).toBe('tv');
    kodi('reconnecting');
    await waitFor(() => expect(result.current).toBe('browser'));
    kodi('connected');
    await waitFor(() => expect(result.current).toBe('tv'));
  });

  it('an explicit TV stays the TV with Kodi down, and one tap on This device moves off it', async () => {
    auth.set('PAIRED1', 'paired');
    localStorage.setItem('hmc.playTarget', 'tv');
    playTarget.reload();
    const { result } = target();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    kodi('reconnecting');
    expect(result.current).toBe('tv');
    act(() => playTarget.set('browser'));
    expect(result.current).toBe('browser');
  });
});
