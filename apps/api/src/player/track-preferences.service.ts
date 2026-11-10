import type { KodiStream, PlayerStatus } from '@home-media-cast/shared';
import { DbService } from '../db/db.service.js';
import { matchStream, TrackChoices, type TrackChoice } from './track-choices.js';

export { matchStream };

type Active = Extract<PlayerStatus, { active: true }>;

/** Subtitles can be added a moment after the video starts; stop looking after this long. */
const LOOK_FOR_MS = 30_000;

const choiceOf = (s: KodiStream): TrackChoice => ({ language: s.language, name: s.name });

/**
 * Remembers the audio and subtitle track the household picked last and applies the same choice
 * to the next playback, so a series keeps its language from one episode to the next.
 */
export class TrackPreferences {
  /** The stored choice, shared with the browser player. */
  readonly choices: TrackChoices;

  constructor(
    db: DbService,
    private readonly commands: {
      setAudioStream(index: number): Promise<void>;
      setSubtitle(index: number | 'off'): Promise<void>;
    },
    /** Reads the player; used to learn which track an index in a request stands for. */
    private readonly current: () => Promise<PlayerStatus>,
  ) {
    this.choices = new TrackChoices(db);
  }

  /** Call after the user picked audio stream `index`. Never throws. */
  async rememberAudio(index: number): Promise<void> {
    const s = await this.safeStatus();
    const stream = s?.audioStreams.find((a) => a.index === index);
    if (stream) this.choices.setAudio(choiceOf(stream));
  }

  /** Call after the user picked subtitle `index`, or `'off'`. Never throws. */
  async rememberSubtitle(index: number | 'off'): Promise<void> {
    if (index === 'off') return this.choices.setSubtitle('off');
    const s = await this.safeStatus();
    const stream = s?.subtitles.find((a) => a.index === index);
    if (stream) this.choices.setSubtitle(choiceOf(stream));
  }

  /**
   * For one new playback: feed it every status and it switches to the remembered tracks once,
   * as soon as they are listed. Failures are ignored; the video just plays with Kodi's default.
   */
  forPlayback(): (s: Active) => void {
    const startedAt = Date.now();
    let audioDone = !this.choices.audio;
    let subtitleDone = !this.choices.subtitle;
    return (s) => {
      const { audio, subtitle } = this.choices;
      if (!audioDone && audio && s.audioStreams.length > 0) {
        audioDone = true;
        const want = matchStream(s.audioStreams, audio);
        if (want && want.index !== s.currentAudioStream)
          void this.attempt(() => this.commands.setAudioStream(want.index));
      }
      if (!subtitleDone && subtitle) {
        if (subtitle === 'off') {
          subtitleDone = true;
          if (s.subtitleEnabled) void this.attempt(() => this.commands.setSubtitle('off'));
        } else {
          const want = matchStream(s.subtitles, subtitle);
          if (want) {
            subtitleDone = true;
            if (!s.subtitleEnabled || want.index !== s.currentSubtitle) {
              void this.attempt(() => this.commands.setSubtitle(want.index));
            }
          } else if (Date.now() - startedAt > LOOK_FOR_MS) {
            subtitleDone = true;
          }
        }
      }
    };
  }

  private async safeStatus(): Promise<Active | undefined> {
    try {
      const s = await this.current();
      return s.active ? s : undefined;
    } catch {
      return undefined;
    }
  }

  private async attempt(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      // the player may have moved on; nothing to recover
    }
  }
}
