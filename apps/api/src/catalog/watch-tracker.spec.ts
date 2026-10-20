import type { PlayerEvent, PlayerStatus } from '@home-media-cast/shared';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbService } from '../db/db.service.js';
import type { PlayerStatusService } from '../player/player-status.service.js';
import { LibraryService } from './library.service.js';
import { WatchTracker } from './watch-tracker.service.js';

const playing = (title: string, positionMs: number, speed = 1): PlayerStatus => ({
  active: true,
  playerId: 1,
  speed,
  positionMs,
  durationMs: 100 * 60_000,
  title,
  audioStreams: [],
  currentAudioStream: null,
  subtitles: [],
  currentSubtitle: null,
  subtitleEnabled: false,
  volume: 50,
  muted: false,
});
const idle: PlayerStatus = { active: false, volume: 50, muted: false };

const ITEM = {
  title: { id: 'tt0903747', type: 'series' as const, name: 'Breaking Bad' },
  videoId: 'tt0903747:1:2',
  season: 1,
  episode: 2,
  label: 'Cat',
};

describe('WatchTracker', () => {
  let subject: Subject<PlayerEvent>;
  let library: LibraryService;
  let tracker: WatchTracker;
  let db: DbService;
  let seek: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  const emit = (data: PlayerStatus) => subject.next({ type: 'status', data });
  const row = () => library.progressOf('tt0903747').find((p) => p.videoId === ITEM.videoId);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    subject = new Subject();
    db = new DbService(':memory:');
    library = new LibraryService(db);
    const player = { stream: () => new Observable<PlayerEvent>((s) => subject.subscribe(s)) };
    seek = vi.fn(async () => undefined);
    tracker = new WatchTracker(player as unknown as PlayerStatusService, library, seek, {
      saveEveryMs: 5000,
      startTimeoutMs: 1000,
      seekRetryMs: 100,
    });
  });
  afterEach(() => {
    tracker.end();
    db.onModuleDestroy();
    vi.useRealTimers();
  });

  it('saves the position while playing, throttled, and again when the TV stops', () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 60_000));
    expect(row()?.positionMs).toBe(60_000);
    vi.setSystemTime(Date.now() + 1000);
    emit(playing('a.mkv', 61_000));
    expect(row()?.positionMs).toBe(60_000); // throttled
    vi.setSystemTime(Date.now() + 6000);
    emit(playing('a.mkv', 67_000));
    expect(row()?.positionMs).toBe(67_000);
    emit(playing('a.mkv', 70_000));
    emit(idle);
    expect(row()).toMatchObject({ positionMs: 70_000, watched: false, label: 'Cat' });
  });

  it('remembers the release at once, even when the play is stopped in seconds, and never exposes it', () => {
    const KEY = '{"g":"grp","r":"1080p","l":[],"h":"abc123hash"}';
    tracker.begin(ITEM, undefined, undefined, KEY);
    expect(library.lastReleaseOf(ITEM.videoId)).toBe(KEY);
    emit(playing('a.mkv', 5_000));
    emit(idle);
    expect(row()).toBeUndefined(); // too short for progress...
    expect(library.lastReleaseOf(ITEM.videoId)).toBe(KEY); // ...but the source is remembered

    // A later play that does not know its release (a pasted link) leaves the old one.
    tracker.begin(ITEM, undefined);
    expect(library.lastReleaseOf(ITEM.videoId)).toBe(KEY);
    // A newer release replaces it; a manual watched toggle keeps it.
    tracker.begin(ITEM, undefined, undefined, '{"r":"720p","l":[],"h":"zzz"}');
    library.setWatched(ITEM, true);
    expect(library.lastReleaseOf(ITEM.videoId)).toBe('{"r":"720p","l":[],"h":"zzz"}');
    expect(JSON.stringify(library.overview())).not.toMatch(/abc123hash|zzz/);
  });

  it('has no release for a video that was never played from a source', () => {
    expect(library.lastReleaseOf('tt0000001')).toBeUndefined();
  });

  it('ignores a video that was already on screen, then follows the new one', () => {
    const before = playing('old.mkv', 3_000_000);
    tracker.begin(ITEM, before);
    emit(playing('old.mkv', 3_001_000));
    expect(row()).toBeUndefined();
    emit(playing('new.mkv', 40_000));
    expect(row()?.positionMs).toBe(40_000);
  });

  it('marks watched past 90% and resets the position', () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 95 * 60_000));
    emit(idle);
    expect(row()).toMatchObject({ watched: true, positionMs: 0 });
  });

  it('does not store a position under 30 seconds', () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 10_000));
    emit(idle);
    expect(row()).toBeUndefined();
  });

  it('keeps "watched" when a finished episode is started again', () => {
    library.setWatched(ITEM, true);
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 120_000));
    emit(idle);
    expect(row()).toMatchObject({ watched: true, positionMs: 120_000 });
  });

  it('gives up when the TV never starts, and stops listening', () => {
    tracker.begin(ITEM, undefined);
    vi.advanceTimersByTime(1500);
    expect(subject.observed).toBe(false);
  });

  it('a second begin ends the first and keeps its last position', () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 50_000));
    tracker.begin({ ...ITEM, videoId: 'tt0903747:1:3', episode: 3 }, undefined);
    expect(row()?.positionMs).toBe(50_000);
    emit(playing('b.mkv', 80_000));
    expect(
      library.progressOf('tt0903747').find((p) => p.videoId === 'tt0903747:1:3'),
    ).toMatchObject({
      positionMs: 80_000,
    });
  });

  it('seeks to the resume point once, when the new video shows up', () => {
    tracker.begin(ITEM, playing('old.mkv', 5_000), 600_000);
    emit(playing('old.mkv', 6_000));
    expect(seek).not.toHaveBeenCalled();
    emit(playing('new.mkv', 1_000));
    emit(playing('new.mkv', 2_000));
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(600_000);
  });

  it('does not seek without a resume point', () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 1_000));
    expect(seek).not.toHaveBeenCalled();
  });

  it('retries a refused seek once and never throws', async () => {
    seek.mockRejectedValueOnce(new Error('too early'));
    tracker.begin(ITEM, undefined, 300_000);
    emit(playing('a.mkv', 1_000));
    await vi.advanceTimersByTimeAsync(200);
    expect(seek).toHaveBeenCalledTimes(2);
  });

  describe('onFinished', () => {
    let finished: ReturnType<typeof vi.fn<(i: unknown, g?: string) => void>>;
    beforeEach(() => {
      finished = vi.fn();
      tracker.onFinished = finished;
    });

    it('fires once with the item and release group when playback ends past 90%', () => {
      tracker.begin(ITEM, undefined, undefined, 'grp|1080p');
      emit(playing('a.mkv', 95 * 60_000));
      expect(finished).not.toHaveBeenCalled();
      emit(idle);
      emit(idle);
      expect(finished).toHaveBeenCalledTimes(1);
      expect(finished).toHaveBeenCalledWith(ITEM, 'grp|1080p');
    });

    it('does not fire when stopped early, or when another play replaces the first', () => {
      tracker.begin(ITEM, undefined);
      emit(playing('a.mkv', 50 * 60_000));
      emit(idle);
      tracker.begin(ITEM, undefined);
      emit(playing('b.mkv', 99 * 60_000));
      tracker.begin({ ...ITEM, videoId: 'tt0903747:1:3', episode: 3 }, undefined);
      expect(finished).not.toHaveBeenCalled();
    });

    it('remembers the last play after it ended', () => {
      tracker.begin(ITEM, undefined, undefined, 'g');
      emit(playing('a.mkv', 95 * 60_000));
      emit(idle);
      expect(tracker.lastPlay()).toEqual({ item: ITEM, bingeGroup: 'g' });
    });
  });
});
