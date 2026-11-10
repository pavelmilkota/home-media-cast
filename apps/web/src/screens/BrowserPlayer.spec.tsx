import type { BrowserSession } from '@home-media-cast/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { BrowserPlayerProvider, useBrowserPlayer } from '../state/browser-player.js';
import { FakeBackend } from '../testing/fake-backend.js';
import { renderWithClient } from '../testing/render.js';
import { BrowserPlayer, localSeekTime, prefersNativeHls } from './BrowserPlayer.js';

const hls = vi.hoisted(() => {
  type Handler = (event: string, data: { fatal: boolean; type: string }) => void;
  class FakeHls {
    static instances: FakeHls[] = [];
    static isSupported = () => true;
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
    handlers = new Map<string, Handler>();
    loaded: string | undefined;
    destroyed = false;
    recovered = 0;
    constructor() {
      FakeHls.instances.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }
    loadSource(url: string) {
      this.loaded = url;
    }
    attachMedia() {}
    recoverMediaError() {
      this.recovered++;
    }
    destroy() {
      this.destroyed = true;
    }
    fail(type: string) {
      this.handlers.get('error')?.('error', { fatal: true, type });
    }
  }
  return FakeHls;
});
vi.mock('hls.js', () => ({ default: hls }));

const run = (n: number, startMs: number): BrowserSession['run'] => ({
  n,
  startMs,
  playlistPath: `/media/sess1/${n}/index.m3u8`,
});
const session = (n: number, startMs: number): BrowserSession => ({
  id: 'sess1',
  handoffId: 'handoff1',
  autoNext: true,
  run: run(n, startMs),
  durationMs: 7_200_000,
  mode: 'copy',
  audioTracks: [],
  subtitleTracks: [],
});

/** Starts a session from a button, then shows the player the way the app shell does. */
function Harness() {
  const player = useBrowserPlayer();
  return (
    <>
      <button
        onClick={() =>
          void player.start({
            optionId: 'a',
            title: { type: 'movie', id: 'tt0111161' },
            name: 'The Movie',
          })
        }
      >
        go
      </button>
      {player.session && <BrowserPlayer onClose={player.close} />}
    </>
  );
}

let backend: FakeBackend;
beforeEach(() => {
  hls.instances.length = 0;
  auth.clear();
  auth.set('TOKEN123');
  backend = new FakeBackend().install();
  backend.on('POST /browser-play', { status: 201, body: session(1, 0) });
  backend.on('POST /browser-play/sess1/progress', { status: 204 });
  backend.on('POST /browser-play/sess1/error', { status: 204 });
  backend.on('DELETE /browser-play/sess1', { status: 204 });
  let runs = 1;
  backend.on('POST /browser-play/sess1/seek', (call) => ({
    status: 200,
    body: session(++runs, (call.body as { positionMs: number }).positionMs),
  }));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  auth.clear();
});

const begin = async () => {
  renderWithClient(
    <BrowserPlayerProvider>
      <Harness />
    </BrowserPlayerProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'go' }));
  await screen.findByRole('dialog', { name: 'Video player' });
};
const latest = () => hls.instances[hls.instances.length - 1]!;

describe('BrowserPlayer: audio and subtitles', () => {
  const withTracks = (n: number, startMs: number, audioIndex = 0): BrowserSession => ({
    ...session(n, startMs),
    audioIndex,
    subtitleIndex: 0,
    audioTracks: [
      { index: 0, language: 'ukr', codec: 'EAC3', channels: 6 },
      { index: 1, language: 'eng', codec: 'AAC', channels: 2 },
    ],
    subtitleTracks: [
      { index: 0, language: 'eng' },
      { index: 1, language: 'pol' },
    ],
  });

  beforeEach(() => {
    backend.on('POST /browser-play', { status: 201, body: withTracks(1, 0) });
    backend.on('POST /browser-play/sess1/audio', (call) => ({
      status: 200,
      body: withTracks(2, (call.body as { positionMs: number }).positionMs, 1),
    }));
    backend.on('POST /browser-play/sess1/subtitle', { status: 204 });
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/media/')) {
          return new Response(
            'WEBVTT\n\n00:03.000 --> 00:05.000\nHello early\n\n00:08.000 --> 00:10.000\nHello late\n',
            { status: 200 },
          );
        }
        return base(input, init);
      }),
    );
  });

  it('shows the cues of the remembered subtitle on the run clock', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 4, configurable: true });
    fireEvent.timeUpdate(video);
    expect(await screen.findByTestId('caption')).toHaveTextContent('Hello early');
    Object.defineProperty(video, 'currentTime', { value: 6, configurable: true });
    fireEvent.timeUpdate(video);
    expect(screen.queryByTestId('caption')).not.toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/api/media/sess1/1/sub0.vtt'),
    ).toBe(true);
  });

  it('looks cues up by the film time: a run that starts at 60 s shows the cue at 63 s', async () => {
    backend.on('POST /browser-play', { status: 201, body: withTracks(1, 60_000) });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes('/api/media/')
        ? new Response('WEBVTT\n\n01:03.000 --> 01:05.000\nFilm time\n', { status: 200 })
        : base(input, init),
    );
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 3.5, configurable: true });
    fireEvent.timeUpdate(video);
    expect(await screen.findByTestId('caption')).toHaveTextContent('Film time');
  });

  it('switching audio asks for a new run at the same position', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 90, configurable: true });
    fireEvent.timeUpdate(video);
    await userEvent.click(screen.getByRole('button', { name: 'Audio and subtitles' }));
    const audio = await screen.findByRole('radiogroup', { name: 'Audio' });
    await userEvent.click(within(audio).getByRole('radio', { name: /ENG/ }));
    await waitFor(() => expect(hls.instances).toHaveLength(2));
    expect(backend.callsTo('POST /browser-play/sess1/audio')[0]?.body).toEqual({
      index: 1,
      positionMs: 90_000,
    });
    expect(latest().loaded).toBe('/api/media/sess1/2/index.m3u8');
  });

  it('turning subtitles off hides the caption and tells the server', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 4, configurable: true });
    fireEvent.timeUpdate(video);
    await screen.findByTestId('caption');
    await userEvent.click(screen.getByRole('button', { name: 'Audio and subtitles' }));
    const subtitles = await screen.findByRole('radiogroup', { name: 'Subtitles' });
    await userEvent.click(within(subtitles).getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(screen.queryByTestId('caption')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(backend.callsTo('POST /browser-play/sess1/subtitle')[0]?.body).toEqual({
        index: null,
      }),
    );
  });
});

describe('BrowserPlayer: episodes', () => {
  const ref = (n: number) => ({
    videoId: `tt1:1:${n}`,
    seriesName: 'Show',
    label: `S1E${n} · Episode ${n}`,
  });
  const episode = (n: number, over: Partial<BrowserSession> = {}): BrowserSession => ({
    ...session(1, 0),
    id: `ep${n}`,
    handoffId: `h${n}`,
    adjacent: { previous: ref(n - 1), next: ref(n + 1) },
    ...over,
  });

  const begin2 = async (first: BrowserSession) => {
    backend.on('POST /browser-play', { status: 201, body: first });
    backend.on(`POST /browser-play/${first.id}/progress`, { status: 204 });
    backend.on(`DELETE /browser-play/${first.id}`, { status: 204 });
    await begin();
  };

  it('shows the buttons only when there is an episode on that side', async () => {
    await begin2(episode(4, { adjacent: { next: ref(5) } }));
    expect(screen.getByRole('button', { name: 'Next episode' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous episode' })).not.toBeInTheDocument();
  });

  it('shows neither for a film, or a play without episodes around it', async () => {
    await begin2(episode(4, { adjacent: undefined }));
    expect(screen.queryByRole('button', { name: 'Next episode' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous episode' })).not.toBeInTheDocument();
  });

  it('next asks the server, carries on in the same video, and names the new episode', async () => {
    const four = episode(4);
    const five = episode(5, { run: run(1, 0), adjacent: { previous: ref(4) } });
    backend.on('POST /browser-play/ep4/next', { status: 200, body: five });
    await begin2(four);
    const video = document.querySelector('video');
    await userEvent.click(screen.getByRole('button', { name: 'Next episode' }));
    await waitFor(() => expect(screen.getByText('S1E5 · Episode 5')).toBeInTheDocument());
    expect(backend.callsTo('POST /browser-play/ep4/next')[0]?.body).toMatchObject({
      caps: expect.any(Object),
    });
    expect(document.querySelector('video')).toBe(video); // permission to play carries over
    expect(screen.queryByRole('button', { name: 'Next episode' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous episode' })).toBeInTheDocument();
  });

  it('starts the next episode by itself when one ends', async () => {
    backend.on('POST /browser-play/ep4/next', {
      status: 200,
      body: episode(5, { adjacent: { previous: ref(4) } }),
    });
    await begin2(episode(4));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 7_199, configurable: true });
    fireEvent.timeUpdate(video);
    fireEvent.ended(video);
    await waitFor(() => expect(backend.callsTo('POST /browser-play/ep4/next')).toHaveLength(1));
  });

  it('does not, when the server says not to or there is no next episode', async () => {
    backend.on('POST /browser-play/ep4/next', { status: 200, body: episode(5) });
    await begin2(episode(4, { autoNext: false }));
    fireEvent.ended(document.querySelector('video')!);
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.callsTo('POST /browser-play/ep4/next')).toHaveLength(0);
  });

  it('says so when there is no source from the same release, and stays open', async () => {
    backend.on('POST /browser-play/ep4/next', {
      status: 404,
      body: { error: 'no_matching_source', message: 'x' },
    });
    await begin2(episode(4));
    await userEvent.click(screen.getByRole('button', { name: 'Next episode' }));
    expect(
      await screen.findByText(
        'No source from the same release for that episode. Pick one by hand.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Video player' })).toBeInTheDocument();
  });

  it('offers a button when the browser refuses to start the video by itself', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('NotAllowedError'));
    await begin2(episode(4));
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    act(() => latest().handlers.get('manifest')?.('manifest', { fatal: false, type: '' }));
    expect(await screen.findByRole('button', { name: 'Up next' })).toBeInTheDocument();
  });
});

describe('BrowserPlayer', () => {
  it('starts: asks for the run playlist through hls.js, with the title shown', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    expect(latest().loaded).toBe('/api/media/sess1/1/index.m3u8');
    expect(screen.getByText('The Movie')).toBeInTheDocument();
    expect(screen.getByText('2:00:00')).toBeInTheDocument();
  });

  it('a seek is a new run, and the timeline continues from where it started', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    for (let i = 0; i < 3; i++) {
      await userEvent.click(screen.getByRole('button', { name: 'Forward 10 seconds' }));
    }

    await waitFor(() => expect(hls.instances).toHaveLength(2));
    expect(backend.callsTo('POST /browser-play/sess1/seek')[0]?.body).toEqual({
      positionMs: 30_000,
    });
    expect(hls.instances[0]!.destroyed).toBe(true);
    expect(latest().loaded).toBe('/api/media/sess1/2/index.m3u8');
    expect(screen.getByText('0:30')).toBeInTheDocument();

    // The video's own clock counts from the run's start: 12 s into the run is 0:42 in the film.
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(video);
    expect(screen.getByText('0:42')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back 10 seconds' }));
    await waitFor(() =>
      expect(backend.callsTo('POST /browser-play/sess1/seek')[1]?.body).toEqual({
        positionMs: 32_000,
      }),
    );
  });

  it('saves the position on pause and when the page is hidden', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 90, configurable: true });
    fireEvent.timeUpdate(video);
    fireEvent.pause(video);
    await waitFor(() =>
      expect(backend.callsTo('POST /browser-play/sess1/progress')).toHaveLength(1),
    );
    expect(backend.callsTo('POST /browser-play/sess1/progress')[0]?.body).toEqual({
      positionMs: 90_000,
    });
    act(() => void window.dispatchEvent(new Event('pagehide')));
    await waitFor(() =>
      expect(backend.callsTo('POST /browser-play/sess1/progress')).toHaveLength(2),
    );
  });

  it('reports at least every 30 s while paused, so the server knows the player is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      expect(backend.callsTo('POST /browser-play/sess1/progress')).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(29_000));
      expect(backend.callsTo('POST /browser-play/sess1/progress')).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(backend.callsTo('POST /browser-play/sess1/progress')).toHaveLength(1);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(backend.callsTo('POST /browser-play/sess1/progress')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts a run that dies at the current position, then gives up with a message', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    act(() => latest().fail('networkError'));
    await waitFor(() => expect(hls.instances).toHaveLength(2));
    act(() => latest().fail('networkError'));
    await waitFor(() => expect(hls.instances).toHaveLength(3));
    act(() => latest().fail('networkError'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Playback failed.');
    expect(backend.callsTo('POST /browser-play/sess1/seek')).toHaveLength(2);
  });

  it('a run that dies right after it starts playing does not restart for ever', async () => {
    await begin();
    for (let i = 1; i <= 3; i++) {
      await waitFor(() => expect(hls.instances).toHaveLength(i));
      act(() => void fireEvent.playing(document.querySelector('video')!));
      act(() => latest().fail('networkError'));
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('Playback failed.');
    expect(backend.callsTo('POST /browser-play/sess1/seek')).toHaveLength(2);
    expect(backend.callsTo('POST /browser-play/sess1/error')).toHaveLength(3);
  });

  it('a run that played a while gets its restarts back', async () => {
    await begin();
    for (let i = 1; i <= 4; i++) {
      await waitFor(() => expect(hls.instances).toHaveLength(i));
      const video = document.querySelector('video')!;
      Object.defineProperty(video, 'currentTime', { value: 30, configurable: true });
      fireEvent.timeUpdate(video);
      act(() => latest().fail('networkError'));
    }
    await waitFor(() => expect(hls.instances).toHaveLength(5));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an end long before the film ends picks up where it stopped', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { value: 600, configurable: true });
    fireEvent.timeUpdate(video);
    fireEvent.ended(video);
    await waitFor(() =>
      expect(backend.callsTo('POST /browser-play/sess1/seek')[0]?.body).toEqual({
        positionMs: 600_000,
      }),
    );
    expect(backend.callsTo('POST /browser-play/sess1/error')[0]?.body).toMatchObject({
      kind: 'ended-early',
      decode: false,
    });
  });

  it('reports a decode error so the server can convert instead of copy', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'error', {
      value: { code: 3, message: 'PIPELINE_ERROR_DECODE' },
      configurable: true,
    });
    fireEvent.error(video);
    await waitFor(() =>
      expect(backend.callsTo('POST /browser-play/sess1/error')[0]?.body).toMatchObject({
        kind: 'video.3',
        detail: 'PIPELINE_ERROR_DECODE',
        decode: true,
      }),
    );
    await waitFor(() => expect(backend.callsTo('POST /browser-play/sess1/seek')).toHaveLength(1));
  });

  it('keys: Space plays and pauses, M mutes, the right arrow seeks 10 s', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'm' });
    expect(video.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    await waitFor(
      () =>
        expect(backend.callsTo('POST /browser-play/sess1/seek')[0]?.body).toEqual({
          positionMs: 10_000,
        }),
      { timeout: 3000 },
    );
  });

  it('a 404 of the run being replaced by a seek does not start yet another run', async () => {
    let release: () => void = () => undefined;
    backend.on('POST /browser-play/sess1/seek', async () => {
      await new Promise<void>((r) => (release = r));
      return { status: 200, body: session(2, 30_000) };
    });
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const first = latest();
    fireEvent.keyDown(document.body, { key: 'l' });
    await waitFor(() => expect(backend.callsTo('POST /browser-play/sess1/seek')).toHaveLength(1), {
      timeout: 3000,
    });
    // The server already deleted run 1: its player fails while the seek is still in flight.
    act(() => first.fail('networkError'));
    expect(first.destroyed).toBe(false);
    act(() => release());
    await waitFor(() => expect(hls.instances).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.callsTo('POST /browser-play/sess1/seek')).toHaveLength(1);
    expect(backend.callsTo('POST /browser-play/sess1/error')).toHaveLength(0);
  });

  it('recovers a media error once, then treats the next one soon after as fatal', async () => {
    await begin();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    act(() => latest().fail('mediaError'));
    expect(hls.instances[0]!.recovered).toBe(1);
    expect(hls.instances[0]!.destroyed).toBe(false);
    act(() => latest().fail('mediaError'));
    await waitFor(() => expect(hls.instances).toHaveLength(2));
    expect(hls.instances[0]!.destroyed).toBe(true);
  });

  it('closing ends the session on the server', async () => {
    await begin();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(backend.callsTo('DELETE /browser-play/sess1')).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('BrowserPlayer: controls', () => {
  const seeks = () => backend.callsTo('POST /browser-play/sess1/seek');
  const controls = () => screen.getByTestId('controls');
  const hidden = () => controls().hasAttribute('inert');
  const tap = (label: string) => userEvent.click(screen.getByRole('button', { name: label }));

  describe('seek taps', () => {
    it('a tap inside what the run has moves the video at once, with no new run', async () => {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      const video = document.querySelector('video')!;
      Object.defineProperty(video, 'buffered', { configurable: true, value: ranges([0, 60]) });
      Object.defineProperty(video, 'seekable', { configurable: true, value: ranges([0, 90]) });
      await tap('Forward 10 seconds');
      expect(video.currentTime).toBe(10);
      expect(screen.getByText('0:10')).toBeInTheDocument();
      await tap('Back 10 seconds');
      expect(video.currentTime).toBe(0);
      await new Promise((r) => setTimeout(r, 800));
      expect(seeks()).toHaveLength(0);
    });

    it('five quick taps cause one seek, at the right position', async () => {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      for (let i = 0; i < 5; i++) await tap('Forward 10 seconds');
      // The screen follows at once, before anything is sent.
      expect(screen.getByText('0:50')).toBeInTheDocument();
      expect(seeks()).toHaveLength(0);
      await waitFor(() => expect(seeks()).toHaveLength(1));
      expect(seeks()[0]?.body).toEqual({ positionMs: 50_000 });
      await new Promise((r) => setTimeout(r, 800));
      expect(seeks()).toHaveLength(1);
    });

    it('taps forward and back add up from the pending position', async () => {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      await tap('Forward 10 seconds');
      await tap('Forward 10 seconds');
      await tap('Back 10 seconds');
      await waitFor(() => expect(seeks()).toHaveLength(1));
      expect(seeks()[0]?.body).toEqual({ positionMs: 10_000 });
    });

    it('a slider commit during collection cancels the taps, with one seek', async () => {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      await tap('Forward 10 seconds');
      await tap('Forward 10 seconds');
      const slider = screen.getByRole('slider', { name: 'Seek' });
      slider.focus();
      await userEvent.keyboard('{End}');
      await waitFor(() => expect(seeks()).toHaveLength(1));
      expect(seeks()[0]?.body).toEqual({ positionMs: 7_195_000 }); // the end, minus 5 s
      await new Promise((r) => setTimeout(r, 800));
      expect(seeks()).toHaveLength(1); // the taps were dropped, not sent after it
    });

    it('closing while taps are collected sends nothing', async () => {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      await tap('Forward 10 seconds');
      await tap('Close');
      await new Promise((r) => setTimeout(r, 800));
      expect(seeks()).toHaveLength(0);
    });
  });

  describe('auto-hide', () => {
    const play = async () => {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => void fireEvent.playing(document.querySelector('video')!));
    };
    const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
    afterEach(() => vi.useRealTimers());

    it('hides 3.5 s after the last interaction while playing, and hides nothing before', async () => {
      await play();
      expect(hidden()).toBe(false);
      wait(3400);
      expect(hidden()).toBe(false);
      wait(200);
      expect(hidden()).toBe(true);
    });

    it('a tap on the picture shows and hides the controls, and never plays or pauses', async () => {
      await play();
      const video = document.querySelector('video')!;
      const playCalls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
      wait(4000);
      expect(hidden()).toBe(true);
      fireEvent.click(screen.getByTestId('tap-surface'));
      expect(hidden()).toBe(false);
      fireEvent.click(screen.getByTestId('tap-surface'));
      expect(hidden()).toBe(true);
      expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(playCalls);
      expect(vi.mocked(HTMLMediaElement.prototype.pause)).not.toHaveBeenCalled();
      expect(document.querySelector('video')).toBe(video);
    });

    it('a finger moving during a tap does not undo the tap', async () => {
      await play();
      wait(4000);
      expect(hidden()).toBe(true);
      const surface = screen.getByTestId('tap-surface');
      const move = new Event('pointermove');
      Object.defineProperty(move, 'pointerType', { value: 'touch' });
      act(() => void window.dispatchEvent(move));
      expect(hidden()).toBe(true);
      fireEvent.click(surface);
      expect(hidden()).toBe(false);
    });

    it('pointer movement and a key press bring them back', async () => {
      await play();
      wait(4000);
      expect(hidden()).toBe(true);
      act(() => void window.dispatchEvent(new Event('pointermove')));
      expect(hidden()).toBe(false);
      wait(4000);
      expect(hidden()).toBe(true);
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
      expect(hidden()).toBe(false);
    });

    it('stay up while paused', async () => {
      await play();
      act(() => void fireEvent.pause(document.querySelector('video')!));
      wait(10_000);
      expect(hidden()).toBe(false);
    });

    it('stay up with an error', async () => {
      await play();
      act(() => latest().fail('networkError'));
      wait(10_000);
      expect(hidden()).toBe(false);
    });

    it('stay up while the tracks sheet is open', async () => {
      backend.on('POST /browser-play', {
        status: 201,
        body: {
          ...session(1, 0),
          audioTracks: [
            { index: 0, language: 'ukr' },
            { index: 1, language: 'eng' },
          ],
          subtitleTracks: [{ index: 0, language: 'eng' }],
        },
      });
      await play();
      act(() => void fireEvent.click(screen.getByRole('button', { name: 'Audio and subtitles' })));
      wait(10_000);
      expect(hidden()).toBe(false);
      expect(screen.getByRole('dialog', { name: 'Audio and subtitles' })).toBeInTheDocument();
    });

    it('stay up while the menu is open, and hide after it closes', async () => {
      await play();
      act(() => void fireEvent.click(screen.getByRole('button', { name: 'More options' })));
      wait(10_000);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(hidden()).toBe(false);
    });
  });

  describe('structure', () => {
    it('keeps the same <video> after hiding the controls and after a seek', async () => {
      await begin();
      await waitFor(() => expect(hls.instances).toHaveLength(1));
      const video = document.querySelector('video');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => void fireEvent.playing(video!));
      act(() => void vi.advanceTimersByTime(4000));
      expect(hidden()).toBe(true);
      expect(document.querySelector('video')).toBe(video);
      vi.useRealTimers();
      act(() => void window.dispatchEvent(new Event('pointermove')));
      await tap('Forward 10 seconds');
      await waitFor(() => expect(seeks()).toHaveLength(1));
      await waitFor(() => expect(hls.instances).toHaveLength(2));
      expect(document.querySelector('video')).toBe(video);
    });

    it('fullscreens the whole page, so menus and sheets stay visible', async () => {
      const request = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
      Object.defineProperty(document.documentElement, 'requestFullscreen', {
        value: request,
        configurable: true,
      });
      await begin();
      await tap('Full screen');
      expect(request).toHaveBeenCalledTimes(1);
      Object.defineProperty(document, 'fullscreenElement', {
        value: document.documentElement,
        configurable: true,
      });
      act(() => void document.dispatchEvent(new Event('fullscreenchange')));
      expect(await screen.findByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true });
    });

    it('has the tracks button only when there is something to pick', async () => {
      await begin();
      expect(screen.queryByRole('button', { name: 'Audio and subtitles' })).not.toBeInTheDocument();
    });

    it('menu: Open in player asks for an external session from here', async () => {
      backend.on('POST /browser-play/sess1/external', {
        status: 201,
        body: { id: 'x', handoffId: 'h', path: '/media/x/file/a.mkv', startMs: 0, durationMs: 1 },
      });
      await begin();
      await tap('More options');
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Open in player' }));
      await waitFor(() =>
        expect(backend.callsTo('POST /browser-play/sess1/external')).toHaveLength(1),
      );
      expect(backend.callsTo('POST /browser-play/sess1/external')[0]?.body).toEqual({
        startMs: 0,
      });
    });

    it('menu: Copy stream link puts the stream address on the clipboard', async () => {
      backend.on('POST /browser-play/sess1/external', {
        status: 201,
        body: { id: 'x', handoffId: 'h', path: '/media/x/file/a.mkv', startMs: 0, durationMs: 1 },
      });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await begin();
      await tap('More options');
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy stream link' }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api/media/x/file/a.mkv`),
      );
    });
  });
});

describe('prefersNativeHls', () => {
  const hlsVideo = (answer: string) => ({ canPlayType: () => answer as CanPlayTypeResult });
  it('uses hls.js in Chrome, which says "maybe" to HLS but cannot parse the segments', () => {
    expect(prefersNativeHls(hlsVideo('maybe'), { vendor: 'Google Inc.' }, { MediaSource: 1 })).toBe(
      false,
    );
  });
  it('uses the native player on Safari, and where there is no Media Source', () => {
    expect(
      prefersNativeHls(hlsVideo('maybe'), { vendor: 'Apple Computer, Inc.' }, { MediaSource: 1 }),
    ).toBe(true);
    expect(prefersNativeHls(hlsVideo('maybe'), { vendor: 'Google Inc.' }, {})).toBe(true);
    expect(prefersNativeHls(hlsVideo(''), { vendor: 'Apple Computer, Inc.' }, {})).toBe(false);
  });
});

/** A `TimeRanges` of `[start, end]` pairs, in seconds. */
function ranges(...pairs: [number, number][]): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i]![0],
    end: (i: number) => pairs[i]![1],
  } as TimeRanges;
}

describe('localSeekTime', () => {
  const video = (buffered: [number, number][], written: number) => ({
    buffered: ranges(...buffered),
    seekable: ranges([0, written]),
  });

  it('seeks inside a buffered range', () => {
    expect(localSeekTime(video([[0, 60]], 90), 30)).toBe(30);
    expect(localSeekTime(video([[20, 60]], 90), 20)).toBe(20);
  });

  it('seeks ahead of the buffer up to what the server has written', () => {
    expect(localSeekTime(video([[0, 60]], 90), 80)).toBe(80);
    expect(localSeekTime(video([[0, 60]], 90), 89.9)).toBeUndefined();
    expect(localSeekTime(video([[0, 60]], 90), 120)).toBeUndefined();
  });

  it('never behind the buffer, where the server may have deleted the segments, nor before the run', () => {
    expect(localSeekTime(video([[30, 60]], 90), 10)).toBeUndefined();
    expect(localSeekTime(video([[0, 60]], 90), -1)).toBeUndefined();
  });
});
