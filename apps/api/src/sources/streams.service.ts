import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AudioProbeResponse,
  AudioTrack,
  StreamOption,
  StreamsCacheStats,
  StreamsResponse,
} from '@home-media-cast/shared';
import {
  AioStreamsClient,
  SourceAuthError,
  SourceNotConfiguredError,
  SourceUnavailableError,
  type TitleType,
  isValidTitleId,
} from '../aiostreams/aiostreams.client.js';
import { KodiInvalidUrlError } from '../kodi/kodi.errors.js';
import type { KodiService } from '../kodi/kodi.service.js';
import { RelayLinkError, type RelayService } from '../relay/relay.service.js';
import { UnreadableContainerError, probeAudio, type RangeReader } from './audio-probe.js';
import type { AudioProbeStore } from './audio-probe.store.js';
import { StreamsCacheStore } from './streams-cache.store.js';
import {
  audioKey,
  mayOpenForAudio,
  classifyResult,
  releaseKey,
  releaseMatch,
  toOption,
  type ClassifiedResult,
} from './stream-source.js';

/** A source link is tried this many times before the phone is told it does not work. */
const LINK_ATTEMPTS = 2;

/** Files being read for their audio tracks at once; each read goes through the debrid service. */
const AUDIO_CONCURRENCY = 2;
/** A file that cannot be read is not tried again for this long (a provider error, not the file). */
const AUDIO_RETRY_AFTER_MS = 2 * 60_000;
const AUDIO_TIMEOUT_MS = 12_000;
/** A header read stays small: requests and bytes per file. */
const AUDIO_MAX_REQUESTS = 12;
const AUDIO_MAX_BYTES = 6 * 1024 * 1024;

const UNAVAILABLE: AudioProbeResponse = { status: 'unavailable' };

/** Named languages of the tracks, once each, in file order. */
const audioLanguages = (tracks: AudioTrack[]): string[] => [
  ...new Set(tracks.flatMap((t) => (t.language ? [t.language] : []))),
];

/** The option id is unknown, or older than the time limit. The list must be fetched again. */
export class OptionExpiredError extends Error {
  override readonly name = 'OptionExpiredError';
}

/** The chosen source's link is dead or refused. Another source may still work. */
export class StreamLinkError extends Error {
  override readonly name = 'StreamLinkError';
  constructor(
    readonly reason: 'expired' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

/** The option exists but cannot be played on the TV (see its `reason`). */
export class NotPlayableError extends KodiInvalidUrlError {}

interface Stored {
  classified: ClassifiedResult;
  expiresAt: number;
}

export interface StreamsOptions {
  ttlMs?: number;
  maxOptions?: number;
  /** Minimum time between two background updates of one title. */
  refreshDebounceMs?: number;
  /** Option ids of a served list are minted again after this long (must be below `ttlMs`). */
  remintAfterMs?: number;
  now?: () => number;
  /** Where the audio tracks read from files are kept; without it files are never read. */
  audio?: AudioProbeStore;
}

/** A cached list as served: the options keep their ids until the entry is replaced or re-minted. */
interface Served {
  fetchedAt: number;
  classified: ClassifiedResult[];
  options: StreamOption[];
  errors: string[];
  mintedAt: number;
}

/** Lists kept in memory; the rest come back from SQLite. */
const MAX_SERVED = 100;

const refreshMessage = (e: unknown): string =>
  e instanceof SourceAuthError
    ? 'AIOStreams refused the credentials'
    : e instanceof SourceUnavailableError
      ? 'AIOStreams is not reachable'
      : 'Could not update the sources';

/**
 * Lists the sources for a title and plays one of them. The provider's URL stays in
 * `Stored.classified.source` inside this process; the frontend gets `StreamOption`s and an
 * opaque id, and Kodi gets a loopback relay URL (ADR-0005, Stage 3 relay decision).
 */
@Injectable()
export class StreamsService {
  private readonly stored = new Map<string, Stored>();
  private readonly ttlMs: number;
  private readonly maxOptions: number;
  private readonly refreshDebounceMs: number;
  private readonly remintAfterMs: number;
  private readonly now: () => number;
  private readonly audio: AudioProbeStore | undefined;
  private readonly audioInflight = new Map<string, Promise<AudioProbeResponse>>();
  /** Per audio key: when a file that failed to read may be tried again. */
  private readonly audioRetryAt = new Map<string, number>();
  private audioActive = 0;
  private readonly audioQueue: (() => void)[] = [];
  /** Per `<type>:<id>`: the list currently served, so polling never touches SQLite or AIOStreams. */
  private readonly served = new Map<string, Served>();
  private readonly inflight = new Map<string, Promise<Served>>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly refreshErrors = new Map<string, string>();
  /** Bumped by `clearCache`; an update that started before it must not bring the lists back. */
  private cacheEpoch = 0;

  constructor(
    private readonly aio: AioStreamsClient | undefined,
    private readonly relay: RelayService,
    private readonly kodi: KodiService,
    private readonly cache: StreamsCacheStore,
    {
      ttlMs = 30 * 60_000,
      maxOptions = 2000,
      refreshDebounceMs = 15_000,
      remintAfterMs = 20 * 60_000,
      now = Date.now,
      audio,
    }: StreamsOptions = {},
  ) {
    this.audio = audio;
    this.ttlMs = ttlMs;
    this.maxOptions = maxOptions;
    this.refreshDebounceMs = refreshDebounceMs;
    this.remintAfterMs = remintAfterMs;
    this.now = now;
  }

  /**
   * Stale-while-revalidate: a cached list is served at once and refreshed in the background (at
   * most once per debounce window, or when `refresh` is set). Without a cached list the search is
   * awaited, as it always was.
   */
  async list(
    type: TitleType,
    id: string,
    { refresh = false, lastRelease }: { refresh?: boolean; lastRelease?: string } = {},
  ): Promise<StreamsResponse> {
    if (!this.aio) throw new SourceNotConfiguredError('AIOStreams is not configured');
    if (!isValidTitleId(type, id)) throw new RangeError('Not a valid title id');
    const key = `${type}:${id}`;
    let served = this.served.get(key);
    if (!served) {
      const cached = this.cache.get(key);
      if (cached) served = this.serve(key, cached.results.map(classifyResult), cached);
    }
    if (!served) {
      // Cold: wait for the search (joining one already running).
      return this.respond(key, await this.refreshNow(type, id, key), lastRelease);
    }
    if (
      !this.inflight.has(key) &&
      (refresh || this.now() - (this.lastAttemptAt.get(key) ?? 0) >= this.refreshDebounceMs)
    ) {
      this.refreshNow(type, id, key).catch(() => undefined);
    }
    if (this.now() - served.mintedAt >= this.remintAfterMs) {
      served = this.serve(key, served.classified, served);
    }
    return this.respond(key, served, lastRelease);
  }

  private respond(key: string, served: Served, lastRelease?: string): StreamsResponse {
    const refreshError = this.refreshErrors.get(key);
    return {
      options: this.withAudio(this.flagLast(served.options, lastRelease)),
      sourceErrors: served.errors,
      fetchedAt: served.fetchedAt,
      refreshing: this.inflight.has(key),
      ...(refreshError ? { refreshError } : {}),
    };
  }

  /**
   * Swaps in the languages already read from a file's own tracks (see `probeAudio`). Applied to the
   * response only, like `flagLast`: `ClassifiedResult.languages` feeds `releaseKey` and stays as
   * the source reported it.
   */
  private withAudio(options: StreamOption[]): StreamOption[] {
    if (!this.audio) return options;
    const keys = new Map<string, string>(); // option id -> audio key
    for (const o of options) {
      const classified = this.stored.get(o.id)?.classified;
      const key = classified?.source.kind === 'direct_url' ? audioKey(classified) : undefined;
      if (key) keys.set(o.id, key);
    }
    if (keys.size === 0) return options;
    const found = this.audio.getMany([...new Set(keys.values())], this.now());
    return options.map((o) => {
      const languages = audioLanguages(found.get(keys.get(o.id) ?? '') ?? []);
      return languages.length ? { ...o, languages, audioVerified: true } : o;
    });
  }

  /**
   * Reads the audio tracks from the start of the file behind an option and keeps them. The link is
   * opened only for sources marked cached (see `mayOpenForAudio`); tracks already stored are
   * returned for any source. Never throws for a file that cannot be read: the answer is
   * `unavailable` and the list keeps its languages.
   */
  async probeAudio(optionId: string): Promise<AudioProbeResponse> {
    const entry = this.stored.get(optionId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.stored.delete(optionId);
      throw new OptionExpiredError('This source is no longer available; search again');
    }
    const { classified } = entry;
    const key = audioKey(classified);
    if (!this.audio || !key || classified.source.kind !== 'direct_url') return UNAVAILABLE;
    const known = this.audio.getMany([key], this.now()).get(key);
    if (known) return this.audioAnswer(known);
    if (!mayOpenForAudio(classified)) return UNAVAILABLE;
    if ((this.audioRetryAt.get(key) ?? 0) > this.now()) return UNAVAILABLE;
    let run = this.audioInflight.get(key);
    if (!run) {
      run = this.readAudio(key, classified).finally(() => this.audioInflight.delete(key));
      this.audioInflight.set(key, run);
    }
    return run;
  }

  private audioAnswer(tracks: AudioTrack[]): AudioProbeResponse {
    const languages = audioLanguages(tracks);
    return languages.length ? { status: 'ok', tracks, languages } : UNAVAILABLE;
  }

  private async readAudio(key: string, classified: ClassifiedResult): Promise<AudioProbeResponse> {
    await this.audioSlot();
    try {
      // The last check before the first request, whatever path got here.
      if (!mayOpenForAudio(classified) || classified.source.kind !== 'direct_url') {
        return UNAVAILABLE;
      }
      const { url, headers } = classified.source;
      const signal = AbortSignal.timeout(AUDIO_TIMEOUT_MS);
      let requests = 0;
      let bytes = 0;
      const read: RangeReader = async (start, length) => {
        if (++requests > AUDIO_MAX_REQUESTS || bytes + length > AUDIO_MAX_BYTES) {
          throw new UnreadableContainerError('Too much to read');
        }
        const data = await this.relay.readRange(
          { url, ...(Object.keys(headers).length ? { headers } : {}) },
          start,
          length,
          signal,
        );
        bytes += data.length;
        return data;
      };
      const tracks = await probeAudio(read);
      (this.audio as AudioProbeStore).put(key, tracks, this.now());
      return this.audioAnswer(tracks);
    } catch (e) {
      if (e instanceof UnreadableContainerError) {
        // The file itself cannot be read this way: remember that, so it is not tried again soon.
        (this.audio as AudioProbeStore).put(key, [], this.now());
      } else {
        this.audioRetryAt.set(key, this.now() + AUDIO_RETRY_AFTER_MS);
      }
      return UNAVAILABLE;
    } finally {
      this.audioDone();
    }
  }

  private audioSlot(): Promise<void> {
    if (this.audioActive < AUDIO_CONCURRENCY) {
      this.audioActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.audioQueue.push(resolve));
  }

  private audioDone(): void {
    const next = this.audioQueue.shift();
    if (next)
      next(); // the slot passes to the next waiter
    else this.audioActive--;
  }

  /**
   * Puts the source played last for this video first and flags it (same torrent, else the same
   * release). Applied to the response only: the served and cached lists are not changed.
   */
  private flagLast(options: StreamOption[], lastRelease: string | undefined): StreamOption[] {
    if (!lastRelease) return options;
    let best: { index: number; score: number } | undefined;
    options.forEach((o, index) => {
      const classified = this.stored.get(o.id)?.classified;
      if (!o.playable || !classified) return;
      let score: number;
      try {
        score = releaseMatch(lastRelease, classified);
      } catch {
        return; // an unreadable stored key flags nothing
      }
      if (score > (best?.score ?? 0)) best = { index, score };
    });
    if (!best) return options;
    const hit = best.index;
    return [{ ...options[hit]!, lastUsed: true }, ...options.filter((_, i) => i !== hit)];
  }

  /** One search per key at a time; the answer is stored, then swapped in as the served list. */
  private refreshNow(type: TitleType, id: string, key: string): Promise<Served> {
    const running = this.inflight.get(key);
    if (running) return running;
    const epoch = this.cacheEpoch;
    const run = (async (): Promise<Served> => {
      try {
        const { results, errors } = await (this.aio as AioStreamsClient).search(type, id);
        const fetchedAt = this.now();
        const classified = results.map(classifyResult);
        if (epoch !== this.cacheEpoch) {
          // Cleared while searching: answer this caller, but leave the cache empty.
          return this.serve(key, classified, { errors, fetchedAt }, false);
        }
        this.cache.put(key, { results, errors }, fetchedAt);
        this.refreshErrors.delete(key);
        // New ids for the new list; the old ids stay playable until their own TTL.
        return this.serve(key, classified, { errors, fetchedAt });
      } catch (e) {
        this.refreshErrors.set(key, refreshMessage(e));
        throw e;
      } finally {
        this.lastAttemptAt.set(key, this.now());
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }

  /** Mints ids once for a classified list and remembers it as the list served for `key`. */
  private serve(
    key: string,
    classified: ClassifiedResult[],
    { errors, fetchedAt }: { errors: string[]; fetchedAt: number },
    keep = true,
  ): Served {
    this.sweep();
    const options = classified.map((c) => toOption(this.remember(c), c));
    // AIOStreams has already filtered and sorted the results by the owner's own settings
    // (language, resolution, cached, ...). Keep that order; only what cannot be played goes last.
    options.sort((a, b) => Number(!a.playable) - Number(!b.playable));
    const served: Served = { fetchedAt, classified, options, errors, mintedAt: this.now() };
    if (!keep) return served;
    this.served.delete(key);
    this.served.set(key, served);
    while (this.served.size > MAX_SERVED)
      this.served.delete(this.served.keys().next().value as string);
    return served;
  }

  cacheStats(): StreamsCacheStats {
    return this.cache.stats();
  }

  /**
   * Empties the cache: the SQLite rows and the lists served from memory. Option ids stay valid,
   * so a play already in progress is unaffected. Returns how many lists were removed.
   */
  clearCache(): number {
    this.cacheEpoch++;
    const cleared = this.cache.clear();
    this.served.clear();
    this.refreshErrors.clear();
    this.lastAttemptAt.clear();
    return cleared;
  }

  private remember(classified: ClassifiedResult): string {
    const optionId = randomBytes(12).toString('base64url');
    while (this.stored.size >= this.maxOptions) {
      this.stored.delete(this.stored.keys().next().value as string);
    }
    this.stored.set(optionId, { classified, expiresAt: Date.now() + this.ttlMs });
    return optionId;
  }

  /** The release (group, resolution, languages) of a listed option; stays in the backend. */
  bingeGroupOf(optionId: string): string | undefined {
    const classified = this.stored.get(optionId)?.classified;
    return classified && releaseKey(classified);
  }

  /**
   * The first source (in AIOStreams' own order) of the same release (group, resolution and
   * languages; any release when `bingeGroup` is undefined) that can be played without starting
   * a download; the same torrent is preferred. Returns an option id for `play`, or undefined.
   */
  async findMatching(
    type: TitleType,
    id: string,
    bingeGroup: string | undefined,
  ): Promise<string | undefined> {
    if (!this.aio) throw new SourceNotConfiguredError('AIOStreams is not configured');
    if (!isValidTitleId(type, id)) throw new RangeError('Not a valid title id');
    const { results } = await this.aio.search(type, id);
    // The same torrent beats a look-alike; within a tier AIOStreams' order decides.
    let best: { score: number; classified: ClassifiedResult } | undefined;
    for (const raw of results) {
      const classified = classifyResult(raw);
      if (classified.source.kind !== 'direct_url' || classified.cached === false) continue;
      const score = bingeGroup === undefined ? 1 : releaseMatch(bingeGroup, classified);
      if (score > (best?.score ?? 0)) best = { score, classified };
      if (score === 2) break;
    }
    if (best) return this.remember(best.classified);
    return undefined;
  }

  /** Starts the option on the TV. Kodi is only ever given a loopback URL or a YouTube id. */
  async play(optionId: string, { resume = false }: { resume?: boolean } = {}): Promise<void> {
    const entry = this.stored.get(optionId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.stored.delete(optionId);
      throw new OptionExpiredError('This source is no longer available; search again');
    }
    const { source, title } = entry.classified;
    if (source.kind === 'youtube') return this.kodi.commands.openYouTube(source.videoId);
    if (source.kind !== 'direct_url') {
      throw new NotPlayableError(toOption(optionId, entry.classified).reason ?? 'Cannot be played');
    }
    // A link that is dead or expired is asked for again once: the relay follows the provider's
    // redirect chain from the start, so a second registration resolves a fresh link.
    let linked: { id: string; url: string } | undefined;
    for (let attempt = 1; !linked; attempt++) {
      const registered = await this.relay.register({
        url: source.url,
        ...(Object.keys(source.headers).length ? { headers: source.headers } : {}),
        name: title,
      });
      try {
        await this.relay.preflight(registered.id);
        linked = registered;
      } catch (e) {
        this.relay.forget(registered.id);
        if (!(e instanceof RelayLinkError)) throw e;
        if (attempt >= LINK_ATTEMPTS) throw new StreamLinkError(e.reason, e.message);
      }
    }
    const { url } = linked;
    await this.kodi.commands.open(url, { resume });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.stored) if (s.expiresAt < now) this.stored.delete(id);
  }
}
