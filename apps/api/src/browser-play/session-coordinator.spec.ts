import { NotFoundException } from '@nestjs/common';
import type { BrowserStatus, PlayerEvent, PlayerStatus } from '@home-media-cast/shared';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbService } from '../db/db.service.js';
import { LibraryService } from '../catalog/library.service.js';
import { WatchTracker } from '../catalog/watch-tracker.service.js';
import type { PlayerStatusService } from '../player/player-status.service.js';
import type { ActiveBrowserSession } from './browser-session.service.js';
import type { SessionHub } from './session-hub.js';
import { SessionCoordinator } from './session-coordinator.js';

const playing = (title: string, positionMs: number): PlayerStatus => ({
  active: true,
  playerId: 1,
  speed: 1,
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
const SESSION_ID = 'SESSION-CAPABILITY-ID';

describe('SessionCoordinator', () => {
  let subject: Subject<PlayerEvent>;
  let calls: string[];
  let confirmResult: boolean;
  let active: ActiveBrowserSession | undefined;
  let listener: (() => void) | undefined;
  let browserStatus: BrowserStatus[];
  let stopFails: boolean;
  let alongside: boolean;
  let current: PlayerStatus;
  let coordinator: SessionCoordinator;
  let tracker: WatchTracker;
  let db: DbService;
  let onFinished: ReturnType<typeof vi.fn<(item: unknown, group?: string) => void>>;
  const emit = (data: PlayerStatus) => {
    current = data;
    subject.next({ type: 'status', data });
  };
  const flush = () => new Promise((r) => setImmediate(r));

  const sessions = {
    confirm: () => {
      calls.push('confirm');
      return confirmResult;
    },
    takeOverFor: async () => {
      if (alongside) return { stopsTv: false };
      calls.push('endOthers');
      return { stopsTv: true };
    },
    endForTv: async () => void calls.push('endForTv'),
    active: () => active,
    onChange: (l: () => void) => (listener = l),
  } as unknown as SessionHub;

  beforeEach(() => {
    subject = new Subject();
    calls = [];
    confirmResult = true;
    active = undefined;
    listener = undefined;
    browserStatus = [];
    stopFails = false;
    alongside = false;
    current = idle;
    db = new DbService(':memory:');
    const player = {
      stream: () => new Observable<PlayerEvent>((s) => subject.subscribe(s)),
      annotate: vi.fn(),
    };
    tracker = new WatchTracker(
      player as unknown as PlayerStatusService,
      new LibraryService(db),
      async () => undefined,
    );
    onFinished = vi.fn<(item: unknown, group?: string) => void>();
    tracker.onFinished = onFinished;
    coordinator = new SessionCoordinator(
      sessions,
      {
        endTracking: () => {
          calls.push('endTracking');
          tracker.end();
        },
        stop: async () => {
          calls.push('stop');
          if (stopFails) throw new Error('Kodi is not responding');
          emit(idle); // Kodi reports the stop
        },
      },
      {
        stream: player.stream,
        current: async () => current,
        setBrowser: (s) => void browserStatus.push(s),
      },
    );
  });
  afterEach(() => {
    coordinator.onModuleDestroy();
    tracker.end();
    db.onModuleDestroy();
  });

  const session = (over: Partial<ActiveBrowserSession> = {}): ActiveBrowserSession => ({
    kind: 'browser',
    id: SESSION_ID,
    deviceId: 'dev1',
    deviceName: 'Phone',
    optionId: 'opt',
    classified: {} as ActiveBrowserSession['classified'],
    title: { type: 'series', id: ITEM.videoId },
    tracked: ITEM,
    positionMs: 61_000,
    durationMs: 6_000_000,
    guest: false,
    ...over,
  });

  it('stops the TV only after the new player confirms, tracker first', async () => {
    emit(playing('a.mkv', 30_000));
    expect(calls).toEqual([]); // nothing happens until the player says it plays
    await coordinator.confirmStarted('s', 'dev1');
    expect(calls).toEqual(['confirm', 'endOthers', 'endTracking', 'stop']);
  });

  it('an external player takes over on its first read: others end, the tracker first, then the TV', async () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 95 * 60_000));
    await coordinator.confirmExternal('ext');
    expect(calls).toEqual(['endOthers', 'endTracking', 'stop']);
    expect(onFinished).not.toHaveBeenCalled(); // the stop past 90% starts no next episode
  });

  it('a session playing alongside confirms and does nothing else: the TV and other sessions stay', async () => {
    alongside = true;
    emit(playing('a.mkv', 30_000));
    await coordinator.confirmStarted('s', 'dev1');
    expect(calls).toEqual(['confirm']);
  });

  it('an external session playing alongside takes nothing over on its first read', async () => {
    alongside = true;
    emit(playing('a.mkv', 30_000));
    await coordinator.confirmExternal('ext');
    expect(calls).toEqual([]);
  });

  it('publishes a guest session, so paired devices see it', async () => {
    active = session({ guest: true });
    listener?.();
    await flush();
    expect(browserStatus.at(-1)).toMatchObject({ active: true, deviceName: 'Phone' });
  });

  it('publishes an external session as approximate', async () => {
    active = session({ kind: 'external', approximate: true });
    listener?.();
    await flush();
    expect(browserStatus.at(-1)).toMatchObject({ active: true, approximate: true });
  });

  it('does not touch the TV when the session is unknown', async () => {
    confirmResult = false;
    await expect(coordinator.confirmStarted('s', 'dev1')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toEqual(['confirm']);
  });

  it('a stop past 90% does not read as "finished" and start the next episode', async () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 95 * 60_000)); // 95% of 100 min
    await coordinator.confirmStarted('s', 'dev1');
    expect(calls).toContain('stop');
    expect(onFinished).not.toHaveBeenCalled();
    // The position is still saved, and the episode counts as watched.
    expect(new LibraryService(db).progressOf(ITEM.title.id)[0]).toMatchObject({ watched: true });
  });

  it('would start the next episode if the TV were stopped without ending the tracker (control)', async () => {
    tracker.begin(ITEM, undefined);
    emit(playing('a.mkv', 95 * 60_000));
    emit(idle); // what a bare stop does
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('ignores a Kodi that is off or has nothing to stop', async () => {
    stopFails = true;
    await expect(coordinator.confirmStarted('s', 'dev1')).resolves.toBeUndefined();
    expect(calls).toEqual(['confirm', 'endOthers', 'endTracking', 'stop']);
  });

  it('a new Kodi playback ends the browser session, however it started', async () => {
    emit(idle);
    active = session();
    listener?.();
    await flush();
    emit(idle); // baseline
    emit(playing('pasted-link.mkv', 0)); // a pasted link, or YouTube casting
    expect(calls).toEqual(['endForTv']);
  });

  it('a different video on the TV ends it too, but the same one ticking does not', async () => {
    emit(playing('a.mkv', 0));
    active = session();
    listener?.();
    await flush();
    emit(playing('a.mkv', 1000)); // the replayed baseline, then position ticks
    emit(playing('a.mkv', 2000));
    expect(calls).toEqual([]);
    emit(playing('youtube.mp4', 0));
    expect(calls).toEqual(['endForTv']);
  });

  it('does not watch the TV when no browser session plays, and stops watching when it ends', async () => {
    expect(subject.observed).toBe(false);
    active = session();
    listener?.();
    await flush();
    expect(subject.observed).toBe(true);
    active = undefined;
    listener?.();
    expect(subject.observed).toBe(false);
    emit(playing('b.mkv', 0));
    expect(calls).toEqual([]);
  });

  it('publishes who plays what, with no session id, media id or position source', async () => {
    active = session();
    listener?.();
    await flush();
    const status = browserStatus.at(-1);
    expect(status).toMatchObject({
      active: true,
      deviceId: 'dev1',
      deviceName: 'Phone',
      media: { name: 'Breaking Bad', season: 1, episode: 2 },
      positionMs: 61_000,
      durationMs: 6_000_000,
    });
    const text = JSON.stringify(status);
    expect(text).not.toContain(SESSION_ID);
    expect(text).not.toContain(ITEM.videoId);
    expect(text).not.toContain('opt');
    expect((status as { handoffId: string }).handoffId).toMatch(/^[\w-]{16}$/);

    active = undefined;
    listener?.();
    expect(browserStatus.at(-1)).toEqual({ active: false });
  });
});
