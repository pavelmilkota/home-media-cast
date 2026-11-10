import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { settings } from '../db/schema.js';

/** A chosen track, described by what survives from one file to the next. */
export interface TrackChoice {
  language: string;
  name: string;
}

export type SubtitleChoice = TrackChoice | 'off';

interface Stored {
  audio?: TrackChoice;
  subtitle?: SubtitleChoice;
}

const KEY = 'track-preferences';

/** The stream that best matches `want`: same language (else same name), same name first. */
export function matchStream<T extends TrackChoice>(streams: T[], want: TrackChoice): T | undefined {
  const sameLanguage = want.language
    ? streams.filter((s) => s.language === want.language)
    : streams.filter((s) => !s.language && s.name === want.name);
  return sameLanguage.find((s) => s.name === want.name) ?? sameLanguage[0];
}

/**
 * The household's remembered audio and subtitle choice, in the settings table. Kodi and the
 * browser player both read and write it, so a language picked on one carries over to the other.
 */
export class TrackChoices {
  private stored: Stored;

  constructor(private readonly db: DbService) {
    const row = db.orm.select().from(settings).where(eq(settings.key, KEY)).get();
    this.stored = row ? (JSON.parse(row.value) as Stored) : {};
  }

  get audio(): TrackChoice | undefined {
    return this.stored.audio;
  }

  get subtitle(): SubtitleChoice | undefined {
    return this.stored.subtitle;
  }

  setAudio(choice: TrackChoice): void {
    this.save({ ...this.stored, audio: choice });
  }

  setSubtitle(choice: SubtitleChoice): void {
    this.save({ ...this.stored, subtitle: choice });
  }

  private save(next: Stored): void {
    this.stored = next;
    const value = JSON.stringify(next);
    this.db.orm
      .insert(settings)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
}
