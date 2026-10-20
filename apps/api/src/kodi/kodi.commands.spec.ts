import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KodiClient } from './kodi.client.js';
import { KodiCommands, safeTitle } from './kodi.commands.js';
import { KodiInvalidUrlError, KodiNoActivePlayerError } from './kodi.errors.js';
import { FakeKodiServer } from './testing/fake-kodi.server.js';

describe('safeTitle', () => {
  it.each([
    [{ title: 'Movie' }, 'Movie'],
    [{ label: 'https://cdn.example.com/dl/movie.mkv?token=SECRET' }, 'movie.mkv'],
    [{ label: 'https://cdn.example.com/dl/My%20Movie.mkv#frag=SECRET' }, 'My Movie.mkv'],
    [{ label: 'https://cdn.example.com/dl/100%.mkv?token=SECRET' }, '100%.mkv'],
    [{ label: 'https://cdn.example.com/?token=SECRET' }, 'cdn.example.com'],
    [{ label: 'movie.mkv?token=SECRET' }, 'movie.mkv'],
    [{ label: 'movie%.mkv#SECRET' }, 'movie%.mkv'],
    [undefined, ''],
  ])('%j -> %j and never contains SECRET', (item, expected) => {
    const title = safeTitle(item);
    expect(title).toBe(expected);
    expect(title).not.toContain('SECRET');
  });
});

describe('KodiCommands', () => {
  let kodi: FakeKodiServer;
  let client: KodiClient;
  let commands: KodiCommands;

  const lastCall = (method: string) => kodi.requests.findLast((r) => r.method === method)?.params;

  beforeEach(async () => {
    kodi = new FakeKodiServer();
    await kodi.start();
    client = new KodiClient({ url: kodi.url, requestTimeoutMs: 500 });
    client.start();
    for (let i = 0; i < 100 && client.state !== 'connected'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    commands = new KodiCommands(client);
  });

  afterEach(async () => {
    client.stop();
    await kodi.stop();
  });

  describe('openYouTube', () => {
    it('opens the fixed plugin URL with only the video id in it', async () => {
      await commands.openYouTube('jNQXAC9IVRw');
      expect(lastCall('Player.Open')).toEqual({
        item: { file: 'plugin://plugin.video.youtube/play/?video_id=jNQXAC9IVRw' },
      });
    });

    it.each([
      '',
      'short',
      'jNQXAC9IVRw1',
      'jNQXAC9IV&w',
      'jNQXAC9IVRw&x=1',
      '../../evil/',
      'http://x/a.mp4',
      'jNQXAC9IVR\n',
    ])('rejects %j and sends nothing', async (id) => {
      await expect(commands.openYouTube(id)).rejects.toBeInstanceOf(KodiInvalidUrlError);
      expect(kodi.requests.filter((r) => r.method === 'Player.Open')).toHaveLength(0);
    });
  });

  describe('setMuted', () => {
    it('sends Application.SetMute', async () => {
      await commands.setMuted(true);
      expect(lastCall('Application.SetMute')).toEqual({ mute: true });
    });
  });

  describe('open', () => {
    it('sends Player.Open with the file and resume option', async () => {
      await commands.open('https://example.com/a.mp4?x=1', { resume: true });
      expect(lastCall('Player.Open')).toEqual({
        item: { file: 'https://example.com/a.mp4?x=1' },
        options: { resume: true },
      });
    });

    it.each([
      'file:///etc/passwd',
      'plugin://plugin.video.youtube/?video_id=x',
      'smb://host/share/a.mp4',
      'special://home/a.mp4',
      'not a url',
      'https://example.com/a.mp4|User-Agent=x',
    ])('refuses %s and sends nothing to Kodi', async (url) => {
      await expect(commands.open(url)).rejects.toBeInstanceOf(KodiInvalidUrlError);
      expect(kodi.requests).toHaveLength(0);
    });
  });

  describe('with no active player', () => {
    beforeEach(() => {
      kodi.on('Player.GetActivePlayers', []);
    });

    it.each([
      ['playPause', () => commands.playPause()],
      ['seek', () => commands.seek({ percentage: 10 })],
      ['stop', () => commands.stop()],
      ['setAudioStream', () => commands.setAudioStream(1)],
      ['setSubtitle', () => commands.setSubtitle('off')],
    ])('%s throws KodiNoActivePlayerError', async (_name, run) => {
      await expect(run()).rejects.toBeInstanceOf(KodiNoActivePlayerError);
    });
  });

  describe('with an active player', () => {
    beforeEach(() => {
      kodi.on('Player.GetActivePlayers', [{ playerid: 1, playertype: 'internal', type: 'video' }]);
    });

    it('toggles or sets play state', async () => {
      await commands.playPause();
      expect(lastCall('Player.PlayPause')).toEqual({ playerid: 1, play: 'toggle' });
      await commands.playPause(false);
      expect(lastCall('Player.PlayPause')).toEqual({ playerid: 1, play: false });
    });

    it('maps the three seek forms', async () => {
      await commands.seek({ positionMs: 3_723_456 });
      expect(lastCall('Player.Seek')).toEqual({
        playerid: 1,
        value: { time: { hours: 1, minutes: 2, seconds: 3, milliseconds: 456 } },
      });
      await commands.seek({ percentage: 150 });
      expect(lastCall('Player.Seek')).toEqual({ playerid: 1, value: { percentage: 100 } });
      await commands.seek({ offsetSeconds: -10.7 });
      expect(lastCall('Player.Seek')).toEqual({ playerid: 1, value: { seconds: -10 } });
    });

    it('selects and hides subtitles', async () => {
      await commands.setSubtitle(2);
      expect(lastCall('Player.SetSubtitle')).toEqual({ playerid: 1, subtitle: 2, enable: true });
      await commands.setSubtitle('off');
      expect(lastCall('Player.SetSubtitle')).toEqual({ playerid: 1, subtitle: 'off' });
    });

    it('stops and switches audio', async () => {
      await commands.stop();
      expect(lastCall('Player.Stop')).toEqual({ playerid: 1 });
      await commands.setAudioStream(1);
      expect(lastCall('Player.SetAudioStream')).toEqual({ playerid: 1, stream: 1 });
    });
  });

  describe('setVolume', () => {
    it('sends valid values', async () => {
      await commands.setVolume(40);
      expect(lastCall('Application.SetVolume')).toEqual({ volume: 40 });
    });

    it.each([-1, 101, 5.5, Number.NaN])('rejects %s without calling Kodi', async (v) => {
      await expect(commands.setVolume(v)).rejects.toBeInstanceOf(RangeError);
      expect(kodi.requests).toHaveLength(0);
    });
  });

  describe('TV window commands', () => {
    it('toggles fullscreen with the fixed toggle value', async () => {
      await commands.toggleFullscreen();
      expect(lastCall('GUI.SetFullscreen')).toEqual({ fullscreen: 'toggle' });
    });

    it('opens the home window and nothing else', async () => {
      await commands.showHome();
      expect(lastCall('GUI.ActivateWindow')).toEqual({ window: 'home' });
      expect(kodi.requests.map((r) => r.method)).toEqual(['GUI.ActivateWindow']);
    });

    it('starts the screensaver and nothing else', async () => {
      await commands.activateScreensaver();
      expect(kodi.requests.map((r) => r.method)).toEqual(['GUI.ActivateScreenSaver']);
    });
  });

  it('shows a notification with a minimum display time', async () => {
    await commands.showNotification('Pairing', 'Code 123456', 100);
    expect(lastCall('GUI.ShowNotification')).toEqual({
      title: 'Pairing',
      message: 'Code 123456',
      displaytime: 1500,
    });
  });

  describe('getStatus', () => {
    beforeEach(() => {
      kodi.on('Application.GetProperties', { volume: 55, muted: false });
    });

    it('reports an idle Kodi', async () => {
      kodi.on('Player.GetActivePlayers', []);
      await expect(commands.getStatus()).resolves.toEqual({
        active: false,
        volume: 55,
        muted: false,
      });
    });

    it('reports idle while only the picture slideshow screensaver runs', async () => {
      kodi.on('Player.GetActivePlayers', [
        { playerid: 2, playertype: 'internal', type: 'picture' },
      ]);
      await expect(commands.getStatus()).resolves.toEqual({
        active: false,
        volume: 55,
        muted: false,
      });
    });

    it('reports idle while the Aerials screensaver video plays', async () => {
      kodi
        .on('Player.GetActivePlayers', [{ playerid: 1, playertype: 'internal', type: 'video' }])
        .on('Player.GetProperties', {
          speed: 1,
          time: { hours: 0, minutes: 0, seconds: 5, milliseconds: 0 },
          totaltime: { hours: 0, minutes: 2, seconds: 0, milliseconds: 0 },
          subtitleenabled: false,
        })
        .on('Player.GetItem', {
          item: {
            file: 'http://sylvan.apple.com/Aerials/2x/Videos/BO_A014.mov',
            label: 'BO_A014.mov',
          },
        });
      await expect(commands.getStatus()).resolves.toEqual({
        active: false,
        volume: 55,
        muted: false,
      });
    });

    it('reports a playing item without leaking the file path', async () => {
      kodi
        .on('Player.GetActivePlayers', [{ playerid: 1, playertype: 'internal', type: 'video' }])
        .on('Player.GetProperties', {
          speed: 1,
          time: { hours: 0, minutes: 1, seconds: 30, milliseconds: 500 },
          totaltime: { hours: 1, minutes: 0, seconds: 0, milliseconds: 0 },
          audiostreams: [
            { index: 0, name: 'AC3', language: 'eng' },
            { index: 1, language: 'rus' },
          ],
          currentaudiostream: { index: 1, language: 'rus' },
          subtitles: [],
          currentsubtitle: null,
          subtitleenabled: false,
        })
        .on('Player.GetItem', {
          item: { label: 'https://cdn.example.com/dl/movie.mkv?token=SECRET', type: 'unknown' },
        });
      const status = await commands.getStatus();
      expect(status).toMatchObject({
        active: true,
        playerId: 1,
        speed: 1,
        positionMs: 90_500,
        durationMs: 3_600_000,
        title: 'movie.mkv',
        currentAudioStream: 1,
        currentSubtitle: null,
        subtitleEnabled: false,
        volume: 55,
      });
      expect(JSON.stringify(status)).not.toContain('SECRET');
    });
  });
});
