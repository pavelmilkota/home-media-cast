import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from './api/auth.js';
import { SearchScreen } from './screens/SearchScreen.js';
import { language } from './state/language.js';
import { LiveProvider } from './state/live.js';
import { FakeBackend, idle, playing } from './testing/fake-backend.js';
import { renderApp, renderWithClient } from './testing/render.js';

let backend: FakeBackend;
beforeEach(() => {
  auth.clear();
  backend = new FakeBackend().install();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  auth.clear();
});

const pair = () => auth.set('TOKEN123');

describe('pairing', () => {
  it('shows the pairing screen when the device has no token', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { name: 'Home Media Cast' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Sections' })).not.toBeInTheDocument();
    expect(backend.eventRequests).toHaveLength(0);
  });

  it('asks the TV for a code without sending any token', async () => {
    backend.on('POST /pairing/start', { status: 200, body: { expiresInSeconds: 300 } });
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Show code on TV' }));
    expect(await screen.findByText(/Look at the TV/)).toBeInTheDocument();
    expect(backend.callsTo('POST /pairing/start')[0]?.authorization).toBeUndefined();
  });

  it.each([
    [429, 'Wait a few seconds before asking for a new code'],
    [503, 'Kodi is not reachable, so the code cannot be shown'],
  ])('explains a %i from /pairing/start', async (status, message) => {
    backend.on('POST /pairing/start', { status, body: { message } });
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Show code on TV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('pairs with the code, stores the token and opens the remote', async () => {
    backend.on('POST /pairing/complete', {
      status: 200,
      body: { deviceId: 'd1', token: 'NEWTOKEN' },
    });
    await renderApp();
    const pairButton = screen.getByRole('button', { name: 'Pair' });
    expect(pairButton).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Code'), '12ab3456');
    expect(screen.getByLabelText('Code')).toHaveValue('123456'); // digits only, max 6
    await userEvent.clear(screen.getByLabelText('This device is called'));
    await userEvent.type(screen.getByLabelText('This device is called'), 'Pixel');
    await userEvent.click(pairButton);

    expect(await screen.findByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    expect(auth.get()).toBe('NEWTOKEN');
    expect(backend.callsTo('POST /pairing/complete')[0]?.body).toEqual({
      code: '123456',
      deviceName: 'Pixel',
    });
    await waitFor(() => expect(backend.eventRequests[0]?.authorization).toBe('Bearer NEWTOKEN'));
  });

  it('stays on the pairing screen with a message when the code is wrong', async () => {
    backend.on('POST /pairing/complete', {
      status: 401,
      body: { message: 'Invalid or expired code' },
    });
    await renderApp();
    await userEvent.type(screen.getByLabelText('Code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or expired code');
    expect(auth.get()).toBeNull();
  });
});

describe('connection', () => {
  it('opens the event stream with the bearer header, never a token in the URL', async () => {
    pair();
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    expect(backend.eventRequests[0]?.authorization).toBe('Bearer TOKEN123');
    expect(backend.eventRequests[0]?.path).toBe('/events');
  });

  it('shows server and Kodi state', async () => {
    pair();
    await renderApp();
    expect(await screen.findByText('Server')).toBeInTheDocument();
    act(() => backend.pushKodi({ state: 'reconnecting' }));
    expect(await screen.findByText('Kodi reconnecting')).toBeInTheDocument();
  });

  it('says the server is unreachable when both health and the stream fail', async () => {
    pair();
    backend.on('GET /health', { status: 500, body: {} });
    backend.eventsStatus = 503;
    await renderApp();
    expect(await screen.findByText('Server unreachable')).toBeInTheDocument();
  });

  it('signs the device out when the backend says the token was revoked', async () => {
    pair();
    backend.eventsStatus = 401;
    await renderApp();
    expect(await screen.findByRole('button', { name: 'Show code on TV' })).toBeInTheDocument();
    expect(auth.get()).toBeNull();
  });

  it('reconnects after the stream drops', async () => {
    pair();
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.dropStreams());
    expect(await screen.findByText('Server connecting…')).toBeInTheDocument();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(2), { timeout: 3000 });
  });
});

describe('remote', () => {
  const open = async (status = playing()) => {
    pair();
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(status));
    if (status.active)
      await userEvent.click(await screen.findByRole('button', { name: /^Now playing/ }));
  };
  const posted = (path: string) => backend.callsTo(`POST /player${path}`).map((c) => c.body);
  beforeEach(() => {
    for (const p of ['pause', 'resume', 'stop', 'seek', 'volume', 'audio', 'subtitle']) {
      backend.on(`POST /player/${p}`, { status: 204 });
    }
  });

  it('has no mini-player and no remote while nothing plays', async () => {
    await open(idle(33));
    expect(screen.queryByRole('button', { name: /^Now playing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remote' })).not.toBeInTheDocument();
  });

  it('shows the playing title in the mini-player, which pauses without opening the remote', async () => {
    pair();
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(playing()));
    expect(
      await screen.findByRole('button', { name: 'Now playing: Big Buck Bunny' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(posted('/pause')).toHaveLength(1));
    expect(screen.queryByLabelText('Position')).not.toBeInTheDocument();
  });

  it('closes the remote sheet when playback ends', async () => {
    await open();
    expect(await screen.findByRole('group', { name: 'Position' })).toBeInTheDocument();
    act(() => backend.pushStatus(idle(33)));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Position' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /^Now playing/ })).not.toBeInTheDocument();
  });

  it('shows what is playing', async () => {
    await open(playing({ positionMs: 75_000, durationMs: 3_725_000 }));
    expect(await screen.findByRole('heading', { name: 'Big Buck Bunny' })).toBeInTheDocument();
    expect(screen.getByText('1:15')).toBeInTheDocument();
    expect(screen.getByText('1:02:05')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('pauses, then resumes when the stream reports speed 0', async () => {
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(posted('/pause')).toHaveLength(1));
    act(() => backend.pushStatus(playing({ speed: 0 })));
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await waitFor(() => expect(posted('/resume')).toHaveLength(1));
  });

  it('skips and stops', async () => {
    await open();
    await userEvent.click(await screen.findByRole('button', { name: '-10s' }));
    await userEvent.click(screen.getByRole('button', { name: '+30s' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(posted('/stop')).toHaveLength(1));
    expect(posted('/seek')).toEqual([{ offsetSeconds: -10 }, { offsetSeconds: 30 }]);
  });

  /** HeroUI's Slider renders a native range input as the thumb; keyboard moves it by `step`. */
  const thumb = async (name: string) =>
    within(await screen.findByRole('group', { name })).getByRole('slider');

  it('seeks on release with the dragged position', async () => {
    await open();
    const slider = await thumb('Position');
    const from = Number((slider as HTMLInputElement).value);
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(posted('/seek')).toEqual([{ positionMs: from + 1000 }]));
  });

  it('follows the server again after the seek is applied', async () => {
    await open();
    const slider = await thumb('Position');
    act(() => backend.pushStatus(playing({ positionMs: 321_000 })));
    await waitFor(() => expect(slider).toHaveValue('321000'));
  });

  it('sets the volume on release', async () => {
    await open();
    const slider = await thumb('Volume');
    expect(slider).toHaveValue('40');
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(posted('/volume')).toEqual([{ volume: 41 }]));
  });

  const around = {
    previous: { videoId: 'tt1:1:2', seriesName: 'Some Show', label: 'S1E2 · Two' },
    next: { videoId: 'tt1:1:4', seriesName: 'Some Show', label: 'S1E4 · Four' },
  };

  it('goes to the next and the previous episode from the transport controls', async () => {
    backend.on('GET /playback/episodes', { status: 200, body: around });
    backend.on('POST /playback/next', { status: 202, body: { status: 'accepted' } });
    backend.on('POST /playback/previous', { status: 202, body: { status: 'accepted' } });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Next episode: S1E4 · Four' }));
    await waitFor(() => expect(backend.callsTo('POST /playback/next')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Previous episode: S1E2 · Two' }));
    await waitFor(() => expect(backend.callsTo('POST /playback/previous')).toHaveLength(1));
  });

  it('disables the side that does not exist, e.g. before the first episode', async () => {
    backend.on('GET /playback/episodes', { status: 200, body: { next: around.next } });
    await open();
    expect(await screen.findByRole('button', { name: 'Previous episode' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Next episode: S1E4/ })).toBeEnabled();
  });

  it('says why an episode could not start', async () => {
    backend.on('GET /playback/episodes', { status: 200, body: around });
    backend.on('POST /playback/next', {
      status: 404,
      body: {
        message: 'No source from the same release for the next episode. Pick a source by hand.',
      },
    });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: /^Next episode/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a source by hand');
  });

  it('shows no episode buttons for something that is not an episode', async () => {
    backend.on('GET /playback/episodes', { status: 200, body: {} });
    await open();
    await screen.findByRole('heading', { name: 'Big Buck Bunny' });
    await waitFor(() => expect(backend.callsTo('GET /playback/episodes')).toHaveLength(1));
    expect(screen.queryByRole('group', { name: 'Episodes' })).not.toBeInTheDocument();
  });

  const choose = async (select: string, option: string) => {
    await userEvent.click(await screen.findByRole('button', { name: new RegExp(select) }));
    await userEvent.click(await screen.findByRole('option', { name: option }));
  };

  it('switches audio track and subtitles (criterion #9, UI side)', async () => {
    await open();
    await choose('Audio', 'AAC · rus');
    await choose('Subtitles', 'SRT · eng');
    await waitFor(() => expect(posted('/subtitle')).toEqual([{ index: 0 }]));
    expect(posted('/audio')).toEqual([{ index: 1 }]);
    act(() => backend.pushStatus(playing({ subtitleEnabled: true, currentSubtitle: 0 })));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Subtitles/ })).toHaveTextContent('SRT · eng'),
    );
    await choose('Subtitles', 'Off');
    await waitFor(() => expect(posted('/subtitle')).toEqual([{ index: 0 }, { index: 'off' }]));
  });

  it('disables the audio picker when there is only one track', async () => {
    await open(
      playing({ audioStreams: [{ index: 0, name: 'AC3', language: 'eng' }], subtitles: [] }),
    );
    expect(await screen.findByRole('button', { name: /Audio/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Subtitles/ })).toBeDisabled();
  });

  it('shows the backend message when a command fails', async () => {
    backend.on('POST /player/pause', {
      status: 503,
      body: { error: 'kodi_unavailable', message: 'Kodi is not responding' },
    });
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kodi is not responding');
  });
});

describe('play a link from Search', () => {
  const openPlay = async (status = idle()) => {
    pair();
    await renderApp();
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(status));
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }));
  };

  it('sends the link and moves to the remote once Kodi is playing', async () => {
    backend.on('POST /playback', { status: 202, body: { status: 'accepted' } });
    await openPlay();
    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      '  https://example.com/a.mp4  ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Play on TV' }));
    await waitFor(() => expect(backend.callsTo('POST /playback')).toHaveLength(1));
    expect(backend.callsTo('POST /playback')[0]?.body).toEqual({
      kind: 'direct_url',
      url: 'https://example.com/a.mp4',
    });
    expect(await screen.findByText('Waiting for the TV to start the video…')).toBeInTheDocument();

    act(() => backend.pushStatus(playing()));
    expect(await screen.findByText('Big Buck Bunny')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  // Real Kodi 21.3 accepts a broken link (the API answers 202) and stops ~100 ms later, so the
  // status never becomes active. The screen must say so instead of waiting forever.
  it('reports a link the TV could not play, then allows another try', async () => {
    backend.on('POST /playback', { status: 202, body: { status: 'accepted' } });
    const started = vi.fn();
    renderWithClient(
      <LiveProvider token="TOKEN123">
        <SearchScreen
          query=""
          onQuery={vi.fn()}
          onOpen={vi.fn()}
          onStarted={started}
          startTimeoutMs={150}
        />
      </LiveProvider>,
    );
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(idle()));

    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      'https://example.com/broken.mp4',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Play on TV' }));
    expect(await screen.findByText(/did not start the video/)).toBeInTheDocument();
    expect(started).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play on TV' })).toBeEnabled();
  });

  it('recognises a new video even when something was already playing', async () => {
    backend.on('POST /playback', { status: 202, body: { status: 'accepted' } });
    const started = vi.fn();
    renderWithClient(
      <LiveProvider token="TOKEN123">
        <SearchScreen
          query=""
          onQuery={vi.fn()}
          onOpen={vi.fn()}
          onStarted={started}
          startTimeoutMs={5000}
        />
      </LiveProvider>,
    );
    await waitFor(() => expect(backend.eventRequests).toHaveLength(1));
    act(() => backend.pushStatus(playing({ title: 'Old', positionMs: 300_000 })));
    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      'https://example.com/new.mp4',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Play on TV' }));
    await screen.findByText('Waiting for the TV to start the video…');

    act(() => backend.pushStatus(playing({ title: 'Old', positionMs: 301_000 }))); // same video, just advancing
    expect(started).not.toHaveBeenCalled();
    act(() => backend.pushStatus(playing({ title: 'New', positionMs: 1_000 })));
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  });

  it('shows why the backend refused a link', async () => {
    backend.on('POST /playback', {
      status: 422,
      body: {
        error: 'url_rejected',
        message: 'That address is not allowed (local or private network)',
      },
    });
    await openPlay();
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'http://127.0.0.1:9090');
    await userEvent.click(screen.getByRole('button', { name: 'Play on TV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is not allowed');
  });

  it('sends a YouTube link to the YouTube endpoint, not as a direct link', async () => {
    backend.on('POST /playback/youtube', { status: 202, body: { status: 'accepted' } });
    await openPlay();
    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      ' https://youtu.be/jNQXAC9IVRw?t=30 ',
    );
    expect(screen.getByText('YouTube video')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Play on TV' }));
    await waitFor(() => expect(backend.callsTo('POST /playback/youtube')).toHaveLength(1));
    expect(backend.callsTo('POST /playback/youtube')[0]?.body).toEqual({
      url: 'https://youtu.be/jNQXAC9IVRw?t=30',
    });
    expect(backend.callsTo('POST /playback')).toHaveLength(0);
    expect(await screen.findByText('Waiting for the TV to start the video…')).toBeInTheDocument();
  });

  it.each([
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/playlist?list=PLabcdefghijk123',
    'https://youtu.be/short',
    'https://www.youtube.com/',
  ])('does not send %s, which is not a single YouTube video', async (link) => {
    await openPlay();
    await userEvent.type(screen.getByLabelText('Movie or series title'), link);
    expect(screen.getByRole('alert')).toHaveTextContent('not a single video');
    expect(screen.getByRole('button', { name: 'Play on TV' })).toBeDisabled();
    expect(backend.callsTo('POST /playback')).toHaveLength(0);
    expect(backend.callsTo('POST /playback/youtube')).toHaveLength(0);
  });

  it('still sends other links as direct links, YouTube look-alikes included', async () => {
    backend.on('POST /playback', { status: 202, body: { status: 'accepted' } });
    await openPlay();
    await userEvent.type(
      screen.getByLabelText('Movie or series title'),
      'https://notyoutube.com/a.mp4',
    );
    expect(screen.queryByText('YouTube video')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Play on TV' }));
    await waitFor(() => expect(backend.callsTo('POST /playback')).toHaveLength(1));
  });

  it('does not offer to play anything until the text is a link', async () => {
    await openPlay();
    await userEvent.type(screen.getByLabelText('Movie or series title'), 'inception');
    expect(screen.queryByRole('button', { name: 'Play on TV' })).not.toBeInTheDocument();
  });
});

describe('devices', () => {
  const devices = [
    { id: 'me', name: 'Pixel', createdAt: 1, lastSeenAt: Date.now(), current: true },
    { id: 'other', name: 'iPad', createdAt: 1, lastSeenAt: null, current: false },
  ];
  const openDevices = async () => {
    pair();
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
  };

  it('lists devices and marks this one', async () => {
    backend.on('GET /devices', { status: 200, body: devices });
    await openDevices();
    expect(await screen.findByText('iPad')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText(/Last seen never/)).toBeInTheDocument();
  });

  it('revokes another device after confirmation and refreshes the list', async () => {
    let list = devices;
    backend.on('GET /devices', () => ({ status: 200, body: list }));
    backend.on('DELETE /devices/other', () => {
      list = devices.slice(0, 1);
      return { status: 204 };
    });
    await openDevices();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke iPad' }));
    expect(backend.callsTo('DELETE /devices/other')).toHaveLength(0); // not yet: needs confirmation
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByText('iPad')).not.toBeInTheDocument());
    expect(auth.get()).toBe('TOKEN123');
  });

  it('signs this phone out when it revokes itself', async () => {
    backend.on('GET /devices', { status: 200, body: devices });
    backend.on('DELETE /devices/me', { status: 204 });
    await openDevices();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Pixel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('button', { name: 'Show code on TV' })).toBeInTheDocument();
    expect(auth.get()).toBeNull();
  });
});

describe('TV controls', () => {
  const openSettings = async () => {
    pair();
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
  };

  it('toggles fullscreen and opens the Kodi home', async () => {
    backend.on('POST /tv/fullscreen', { status: 204 });
    backend.on('POST /tv/home', { status: 204 });
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Toggle fullscreen' }));
    await waitFor(() => expect(backend.callsTo('POST /tv/fullscreen')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Kodi home' }));
    await waitFor(() => expect(backend.callsTo('POST /tv/home')).toHaveLength(1));
  });

  it('starts the screensaver', async () => {
    backend.on('POST /tv/screensaver', { status: 204 });
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Start screensaver' }));
    await waitFor(() => expect(backend.callsTo('POST /tv/screensaver')).toHaveLength(1));
  });

  it('asks before restarting Kodi, then says it was requested', async () => {
    backend.on('POST /tv/restart-kodi', { status: 202, body: { status: 'requested' } });
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Restart Kodi' }));
    expect(backend.callsTo('POST /tv/restart-kodi')).toHaveLength(0); // needs confirmation
    await userEvent.click(screen.getByRole('button', { name: 'Confirm restart' }));
    expect(await screen.findByText('Restart requested')).toBeInTheDocument();
    expect(backend.callsTo('POST /tv/restart-kodi')).toHaveLength(1);
  });

  it('cancels a restart without calling the API', async () => {
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Restart Kodi' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel restart' }));
    expect(screen.getByRole('button', { name: 'Restart Kodi' })).toBeInTheDocument();
    expect(backend.callsTo('POST /tv/restart-kodi')).toHaveLength(0);
  });

  it('shows the backend message when the restart is refused', async () => {
    backend.on('POST /tv/restart-kodi', {
      status: 429,
      body: {
        error: 'restart_rate_limited',
        message: 'Kodi was just asked to restart. Try again in 20 s',
      },
    });
    await openSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'Restart Kodi' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm restart' }));
    expect(await screen.findByText(/Try again in 20 s/)).toBeInTheDocument();
  });
});

describe('language', () => {
  afterEach(() => language.set('auto'));

  it('switches the whole UI from Settings and remembers the choice', async () => {
    pair();
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Polski' }));
    expect(await screen.findByRole('heading', { name: 'Ustawienia' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Sekcje', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Polski' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('hmc.lang')).toBe('pl');
    expect(document.documentElement.lang).toBe('pl');

    await userEvent.click(screen.getByRole('button', { name: 'Automatycznie (język urządzenia)' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(localStorage.getItem('hmc.lang')).toBeNull();
  });
});
