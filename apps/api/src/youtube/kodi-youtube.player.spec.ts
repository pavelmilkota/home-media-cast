import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Constants, type Video } from 'yt-cast-receiver';
import { KodiService } from '../kodi/kodi.service.js';
import { FakeKodiServer } from '../kodi/testing/fake-kodi.server.js';
import { KodiYouTubePlayer } from './kodi-youtube.player.js';
import { ReceiverLogger } from './receiver-logger.js';

const { PLAYER_STATUSES } = Constants;
const ID = 'jNQXAC9IVRw';

const video = (id: string): Video =>
  ({ id, client: { key: 'YT', theme: 'cl', name: 'YouTube' } }) as unknown as Video;

const wait = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('wait timed out');
};

describe('KodiYouTubePlayer', () => {
  let kodi: FakeKodiServer;
  let service: KodiService;
  let player: KodiYouTubePlayer;
  let playing = false;

  const calls = (method: string) => kodi.requests.filter((r) => r.method === method);

  beforeEach(async () => {
    playing = false;
    kodi = new FakeKodiServer();
    await kodi.start();
    kodi
      .on('JSONRPC.Version', { version: { major: 13, minor: 5, patch: 0 } })
      .on('Application.GetProperties', { volume: 40, muted: false })
      .onCall('Player.GetActivePlayers', () => (playing ? [{ playerid: 1 }] : []))
      .onCall('Player.GetProperties', () => ({
        speed: 1,
        time: { hours: 0, minutes: 1, seconds: 30, milliseconds: 0 },
        totaltime: { hours: 0, minutes: 10, seconds: 0, milliseconds: 0 },
        subtitleenabled: false,
      }))
      .on('Player.GetItem', { item: { title: 'Me at the zoo' } })
      .on('Player.PlayPause', { speed: 0 })
      .on('Player.Seek', {})
      .onCall('Player.Stop', () => {
        playing = false;
        return 'OK';
      })
      .on('Application.SetVolume', 40)
      .on('Application.SetMute', true)
      .onCall('Player.Open', () => {
        // Like the real addon: OK first, playback starts a moment later.
        setTimeout(() => {
          playing = true;
          kodi.notify('Player.OnAVStart', { data: { item: { type: 'unknown' } } });
        }, 20);
        return 'OK';
      });
    service = new KodiService({
      url: kodi.url,
      requestTimeoutMs: 300,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 50,
    });
    service.onModuleInit();
    await wait(() => service.health().version !== undefined);
    player = new KodiYouTubePlayer(service, { startTimeoutMs: 400, statusCacheMs: 0 });
    player.setLogger(new ReceiverLogger());
    player.attach();
  });

  afterEach(async () => {
    player.detach();
    service.onModuleDestroy();
    await kodi.stop();
  });

  describe('play', () => {
    it('opens the fixed plugin URL and reports playing once Kodi starts it', async () => {
      expect(await player.play(video(ID), 0)).toBe(true);
      expect(calls('Player.Open')).toEqual([
        {
          method: 'Player.Open',
          params: { item: { file: `plugin://plugin.video.youtube/play/?video_id=${ID}` } },
        },
      ]);
      expect(player.status).toBe(PLAYER_STATUSES.PLAYING);
      expect(calls('Player.Seek')).toHaveLength(0);
    });

    it('seeks to the start position after Kodi has started', async () => {
      expect(await player.play(video(ID), 533)).toBe(true);
      expect(calls('Player.Seek')).toEqual([
        {
          method: 'Player.Seek',
          params: {
            playerid: 1,
            value: { time: { hours: 0, minutes: 8, seconds: 53, milliseconds: 0 } },
          },
        },
      ]);
    });

    it.each(['', 'short', `${ID}&x=1`, '../../etc/passwd', 'plugin://x'])(
      'refuses the id %j without talking to Kodi',
      async (id) => {
        expect(await player.play(video(id), 0)).toBe(false);
        expect(calls('Player.Open')).toHaveLength(0);
      },
    );

    // Recorded on the real Kodi 21.3 + addon 7.4.4: Player.Open answered OK while the addon's
    // first-run wizard was open and nothing played.
    it('fails when Kodi says OK but never starts playing', async () => {
      kodi.onCall('Player.Open', () => 'OK');
      expect(await player.play(video(ID), 0)).toBe(false);
      expect(player.status).not.toBe(PLAYER_STATUSES.PLAYING);
    });

    it('fails when Kodi rejects the open', async () => {
      kodi.onCall('Player.Open', () => {
        throw new Error('no');
      });
      expect(await player.play(video(ID), 0)).toBe(false);
    });
  });

  describe('commands from the phone', () => {
    beforeEach(async () => {
      await player.play(video(ID), 0);
    });

    it('pause and resume map onto Player.PlayPause', async () => {
      expect(await player.pause()).toBe(true);
      expect(await player.resume()).toBe(true);
      expect(calls('Player.PlayPause').map((c) => c.params)).toEqual([
        { playerid: 1, play: false },
        { playerid: 1, play: true },
      ]);
      expect(player.status).toBe(PLAYER_STATUSES.PLAYING);
    });

    it('seek converts seconds to a Kodi time', async () => {
      expect(await player.seek(75)).toBe(true);
      expect(calls('Player.Seek').at(-1)?.params).toEqual({
        playerid: 1,
        value: { time: { hours: 0, minutes: 1, seconds: 15, milliseconds: 0 } },
      });
    });

    it('volume sets the level and the muted state', async () => {
      expect(await player.setVolume({ level: 63.6, muted: true })).toBe(true);
      expect(calls('Application.SetVolume').at(-1)?.params).toEqual({ volume: 64 });
      expect(calls('Application.SetMute').at(-1)?.params).toEqual({ mute: true });
    });

    it('stop stops Kodi, and stopping with nothing playing is fine', async () => {
      expect(await player.stop()).toBe(true);
      expect(calls('Player.Stop')).toHaveLength(1);
      expect(await player.stop()).toBe(true);
    });

    it('reports position, duration and volume from Kodi in seconds', async () => {
      expect(await player.getPosition()).toBe(90);
      expect(await player.getDuration()).toBe(600);
      expect(await player.getVolume()).toEqual({ level: 40, muted: false });
    });

    it('answers false instead of throwing when Kodi is gone', async () => {
      kodi.setSilent(true);
      expect(await player.pause()).toBe(false);
    });
  });

  describe('changes made on Kodi', () => {
    let states: { status: number }[];
    beforeEach(async () => {
      await player.play(video(ID), 0);
      states = [];
      player.on('state', ({ current }) => states.push(current));
    });

    it('a pause on Kodi reaches the phone', async () => {
      kodi.notify('Player.OnPause', { data: {} });
      await wait(() => states.some((s) => s.status === PLAYER_STATUSES.PAUSED));
      kodi.notify('Player.OnResume', { data: {} });
      await wait(() => states.some((s) => s.status === PLAYER_STATUSES.PLAYING));
    });

    it('stopping on Kodi stops the cast session', async () => {
      kodi.notify('Player.OnStop', { data: { end: false } });
      await wait(() => player.status === PLAYER_STATUSES.STOPPED);
    });

    it('a seek or volume change on Kodi is announced without changing the status', async () => {
      kodi.notify('Player.OnSeek', { data: {} });
      await wait(() => states.length === 1);
      kodi.notify('Application.OnVolumeChanged', { data: { volume: 10, muted: false } });
      await wait(() => states.length === 2);
      expect(states.every((s) => s.status === PLAYER_STATUSES.PLAYING)).toBe(true);
    });

    it('ignores Kodi notifications once the cast has stopped', async () => {
      await player.stop();
      const before = states.length;
      kodi.notify('Player.OnPause', { data: {} });
      kodi.notify('Application.OnVolumeChanged', { data: { volume: 10, muted: false } });
      await new Promise((r) => setTimeout(r, 80));
      expect(states).toHaveLength(before);
      expect(player.status).toBe(PLAYER_STATUSES.STOPPED);
    });
  });

  it('ignores Kodi notifications while it was never casting', async () => {
    const states: unknown[] = [];
    player.on('state', (s) => states.push(s));
    kodi.notify('Player.OnPause', { data: {} });
    kodi.notify('Player.OnStop', { data: { end: true } });
    await new Promise((r) => setTimeout(r, 80));
    expect(states).toHaveLength(0);
  });
});
