import type { PlayerStatus } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbService } from '../db/db.service.js';
import { matchStream, TrackPreferences } from './track-preferences.service.js';

type Active = Extract<PlayerStatus, { active: true }>;

const status = (over: Partial<Active> = {}): Active => ({
  active: true,
  playerId: 1,
  speed: 1,
  positionMs: 0,
  durationMs: 60_000,
  title: 'ep',
  audioStreams: [
    { index: 0, name: 'AAC', language: 'rus' },
    { index: 1, name: 'AC3', language: 'eng' },
  ],
  currentAudioStream: 0,
  subtitles: [
    { index: 0, name: 'Forced', language: 'eng' },
    { index: 1, name: 'Full', language: 'eng' },
    { index: 2, name: 'Full', language: 'pol' },
  ],
  currentSubtitle: null,
  subtitleEnabled: false,
  volume: 50,
  muted: false,
  ...over,
});

describe('TrackPreferences', () => {
  let db: DbService;
  let current: PlayerStatus;
  const commands = {
    setAudioStream: vi.fn(async () => undefined),
    setSubtitle: vi.fn(async () => undefined),
  };
  const make = () => new TrackPreferences(db, commands, async () => current);

  beforeEach(() => {
    db = new DbService(':memory:');
    current = status();
    vi.clearAllMocks();
  });
  afterEach(() => db.onModuleDestroy());

  it('matches by language, preferring the same name', () => {
    const s = status().subtitles;
    expect(matchStream(s, { language: 'eng', name: 'Full' })?.index).toBe(1);
    expect(matchStream(s, { language: 'eng', name: 'Other' })?.index).toBe(0);
    expect(matchStream(s, { language: 'deu', name: 'Full' })).toBeUndefined();
  });

  it('applies the remembered audio and subtitle to the next playback, once', async () => {
    const prefs = make();
    await prefs.rememberAudio(1);
    await prefs.rememberSubtitle(1);

    const apply = make().forPlayback(); // a fresh instance: it was persisted
    apply(status({ audioStreams: [], subtitles: [] })); // not listed yet
    expect(commands.setAudioStream).not.toHaveBeenCalled();
    apply(status());
    apply(status());
    expect(commands.setAudioStream).toHaveBeenCalledExactlyOnceWith(1);
    expect(commands.setSubtitle).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('leaves tracks alone when they already match, or nothing was chosen', async () => {
    make().forPlayback()(status());
    expect(commands.setAudioStream).not.toHaveBeenCalled();

    const prefs = make();
    await prefs.rememberAudio(0);
    prefs.forPlayback()(status());
    expect(commands.setAudioStream).not.toHaveBeenCalled();
  });

  it('remembers turning subtitles off', async () => {
    const prefs = make();
    await prefs.rememberSubtitle(1);
    await prefs.rememberSubtitle('off');
    make().forPlayback()(status({ subtitleEnabled: true, currentSubtitle: 1 }));
    expect(commands.setSubtitle).toHaveBeenCalledExactlyOnceWith('off');
  });
});
