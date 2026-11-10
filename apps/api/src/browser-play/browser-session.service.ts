import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type {
  AdjacentEpisodes,
  BrowserAudioTrack,
  BrowserSession,
  BrowserStartDto,
  BrowserSubtitleTrack,
} from '@home-media-cast/shared';
import type { TrackedItem } from '../catalog/watch-tracker.service.js';
import type { RelayService } from '../relay/relay.service.js';
import {
  type StreamsService,
  OptionExpiredError,
  StreamLinkError,
} from '../sources/streams.service.js';
import { releaseKey, type ClassifiedResult } from '../sources/stream-source.js';
import { NoAdjacentEpisodeError } from '../sources/watch-play.service.js';
import { matchStream, type TrackChoices } from '../player/track-choices.js';
import { decideBackpressure } from './backpressure.js';
import { decideMode } from './playback-mode.js';
import {
  FfmpegMissingError,
  buildRunArgs,
  maskLine,
  minimalEnv,
  probeMedia,
  type ChildLike,
  type ProbedAudio,
  type ProbedMedia,
  type ProbedSubtitle,
  type TranscodePlan,
  type SpawnFn,
} from './ffmpeg.js';
import type { AppConfig } from '../config.js';
import { runStartMs, withoutEditLists } from './fmp4.js';

/** What other devices may know of a session: not its id, which is the capability for the media route. */
export const handoffIdOf = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('base64url').slice(0, 16);

/** The device cannot play this source in the browser, and says why (409 `browser_unsupported`). */
export class BrowserUnsupportedError extends Error {
  override readonly name = 'BrowserUnsupportedError';
}

/** Browser playback cannot run on this server, e.g. `ffmpeg` is missing (503). */
export class BrowserUnavailableError extends Error {
  override readonly name = 'BrowserUnavailableError';
}

/**
 * A browser player counts as open for this long after its last report. It reports every 30 s,
 * also while paused, but phones suspend background tabs, so a few missed reports are normal.
 */
export const PLAYER_ALIVE_MS = 5 * 60_000;

/** Where a browser play meets the library: resume point, history and saved positions. */
export interface BrowserProgressSink {
  prepare(dto: { optionId?: string; title?: BrowserStartDto['title']; resume?: boolean }): Promise<{
    item?: TrackedItem;
    resumeMs?: number;
    commit: () => void;
  }>;
  save(item: TrackedItem, positionMs: number, durationMs: number): void;
}

export interface BrowserSessionOptions {
  /** Absent in tests that do not care about the library. */
  progress?: BrowserProgressSink;
  /** Episode lookups for next / previous and for the player's buttons. */
  adjacent?: {
    find(
      item: TrackedItem,
      key: string | undefined,
      direction: 'next' | 'previous',
    ): Promise<{ optionId: string; videoId: string }>;
    neighbors(item: TrackedItem): Promise<AdjacentEpisodes>;
  };
  /** `AUTO_NEXT_EPISODE`: the player starts the next episode when one ends. */
  autoNext?: boolean;
  /** The name a device was paired under, for the status other devices see. */
  deviceName?: (deviceId: string) => string | undefined;
  spawn: SpawnFn;
  /** How video the browser cannot decode is converted; absent or `off` never converts. */
  transcode?: AppConfig['browserPlay']['transcode'];
  /** The household's remembered audio and subtitle language, shared with Kodi. */
  choices?: TrackChoices;
  /** Where run directories live: `<mediaDir>/<session>/<run>/`. Emptied at startup. */
  mediaDir: string;
  /** Segments `ffmpeg` may be in front of the player, and kept behind it. */
  aheadSegments: number;
  behindSegments: number;
  /** No fetch for this long while a run is alive: the run is killed, the session stays. */
  idleMs?: number;
  /** No activity for this long: the session ends. */
  endIdleMs?: number;
  /** How long a run may take to produce its first segment. */
  startTimeoutMs?: number;
  pollMs?: number;
  tickMs?: number;
  now?: () => number;
}

interface Run {
  n: number;
  startMs: number;
  dir: string;
  child: ChildLike;
  relayId: string;
  /** The loopback relay URL `ffmpeg` reads; the next run of the session reads it too. */
  relayUrl: string;
  /** Complete segments seen in the directory at the last tick. */
  written: number;
  /** The highest segment number the player fetched; -1 before the first. */
  fetched: number;
  stopped: boolean;
  exited: boolean;
  /** Killed by us; its exit is not a failure. */
  killed: boolean;
  lastLines: string[];
  /** `PLAY_INIT` is written: the player gets it for `init.mp4`. */
  playInit: boolean;
}

interface Session {
  id: string;
  deviceId: string;
  /** The listed option it started from (backend only); may have expired. */
  optionId: string | undefined;
  /** The player has really started (its first `playing`); until then it takes nothing over. */
  confirmed: boolean;
  /** The last position known, in the film's own time. */
  positionMs: number;
  adjacent: AdjacentEpisodes | undefined;
  /** The source with its provider link. Backend only: a seek late in a film gets its link here. */
  classified: ClassifiedResult;
  title: BrowserStartDto['title'];
  /** What progress is saved under; absent without catalog context. */
  tracked: TrackedItem | undefined;
  media: ProbedMedia;
  mode: 'copy' | 'transcode';
  audioIndex: number;
  /** The subtitle track shown when the player opens (the remembered language), if any. */
  subtitleIndex: number | undefined;
  runCount: number;
  run: Run | undefined;
  lastActivity: number;
  /** The last `progress` report (or the start): what tells a player is still open. */
  lastReport: number;
  /** A guest's play: leaves nothing in the household's data and leaves the TV alone. */
  guest: boolean;
  /**
   * Plays next to the TV and other devices instead of taking over: a guest's play, or a play that is
   * neither converted nor a handoff. Fixed at the start (a copy play that falls back to converting
   * stays alongside).
   */
  alongside: boolean;
  /** A handoff ("Continue here"): on its first play it ends every other session and the TV. */
  takeover: boolean;
  /** A paired device sent it to the TV; it ends when the TV is seen to start. */
  handedOver: boolean;
  ended: boolean;
  /** Seeks and restarts of one session run one after another. */
  chain: Promise<unknown>;
}

/** What a handoff needs to know about the session that is playing. Backend only. */
export interface ActiveBrowserSession {
  /** A session in this browser's player, or one handed to an external player. */
  kind: 'browser' | 'external';
  id: string;
  deviceId: string;
  deviceName: string;
  optionId: string | undefined;
  classified: ClassifiedResult;
  title: BrowserStartDto['title'];
  tracked: TrackedItem | undefined;
  positionMs: number;
  durationMs: number;
  /** The position is estimated, not reported. */
  approximate?: boolean;
  guest: boolean;
}

/** A source to play in the browser: from a listed option, or from a session that already has one. */
export interface SourceStart {
  classified: ClassifiedResult;
  optionId?: string;
  title: BrowserStartDto['title'];
  caps: BrowserStartDto['caps'];
  startMs?: number;
  resume?: boolean;
  /** Set by controllers from the authenticated device. */
  guest?: boolean;
  /** A handoff ("Continue here"): takes over even a play that would otherwise run alongside. */
  takeover?: boolean;
}

export type MediaFile =
  | { kind: 'playlist'; body: string }
  | { kind: 'file'; root: string; name: string; contentType: string };

const SEGMENT_FILE = /^seg(\d+)\.m4s$/;
/** The init segment without edit lists, served for `init.mp4`; never a name the player asks for. */
const PLAY_INIT = 'init-play.mp4';
const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
  vtt: 'text/vtt; charset=utf-8',
};

/** The only names the media route serves (checked again here, not only by the route). */
export const MEDIA_FILE = /^(index\.m3u8|init\.mp4|seg\d{1,9}\.m4s|sub\d{1,3}\.vtt)$/;

/**
 * The one browser playback session: probes the source through the relay, runs `ffmpeg` to HLS,
 * paces it against the player, and cleans up. At most one session exists; starting another ends
 * the first. Session ids are capabilities for the public media route, so they are never logged.
 */
export class BrowserSessionService {
  private readonly logger = new Logger(BrowserSessionService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly listeners: (() => void)[] = [];
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly endIdleMs: number;
  private readonly startTimeoutMs: number;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | undefined;
  /**
   * Set by the module: before a guest's start asks for a link, ends dead sessions of other devices.
   * A live one is left playing; the guest is not refused.
   */
  guestGate: ((deviceId: string) => Promise<void>) | undefined;

  constructor(
    private readonly streams: StreamsService,
    private readonly relay: RelayService,
    private readonly options: BrowserSessionOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 60_000;
    this.endIdleMs = options.endIdleMs ?? 30 * 60_000;
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 100;
  }

  async onModuleInit(): Promise<void> {
    // Whatever a previous process left behind belongs to no session.
    await rm(this.options.mediaDir, { recursive: true, force: true });
    await mkdir(this.options.mediaDir, { recursive: true });
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map((s) => this.end(s)));
    await rm(this.options.mediaDir, { recursive: true, force: true });
  }

  // ----------------------------------------------------------------------------- control

  async start(deviceId: string, dto: BrowserStartDto, guest = false): Promise<BrowserSession> {
    return this.startSource(deviceId, {
      classified: this.streams.resolveOption(dto.optionId),
      optionId: dto.optionId,
      title: dto.title,
      caps: dto.caps,
      ...(dto.startMs !== undefined ? { startMs: dto.startMs } : {}),
      ...(dto.resume !== undefined ? { resume: dto.resume } : {}),
      ...(guest ? { guest } : {}),
    });
  }

  /**
   * Starts a session from a source. The device's own earlier session ends at once; a session of
   * another device keeps playing until this one confirms it has really started (`confirm`), so a
   * handoff never leaves the household with nothing playing.
   */
  async startSource(deviceId: string, src: SourceStart): Promise<BrowserSession> {
    const { classified } = src;
    const dto = src;
    const guest = src.guest === true;
    if (guest) await this.guestGate?.(deviceId);
    const link = await this.streams.linkFor(classified, { name: '' });
    let media: ProbedMedia;
    try {
      media = await probeMedia(this.options.spawn, link.url, { relayIds: [link.id] }, (line) =>
        this.logger.warn(`ffprobe: ${line}`),
      );
    } catch (e) {
      this.relay.forget(link.id);
      if (e instanceof FfmpegMissingError) {
        throw new BrowserUnavailableError('Browser playback is not available on this server');
      }
      throw new BrowserUnsupportedError('This file cannot be played in the browser');
    }
    const decision = decideMode(media.video, dto.caps, {
      transcode: this.transcodeEnabled,
    });
    if (decision.mode === 'unsupported') {
      this.relay.forget(link.id);
      throw new BrowserUnsupportedError(decision.reason);
    }

    const prepared = await this.options.progress?.prepare({
      ...(src.optionId ? { optionId: src.optionId } : {}),
      ...(src.title ? { title: src.title } : {}),
      ...(src.resume !== undefined ? { resume: src.resume } : {}),
    });
    // A guest gets the title's details, but no resume point, and its play is never recorded.
    const library = guest && prepared ? { item: prepared.item, commit: () => undefined } : prepared;

    await Promise.all(
      [...this.sessions.values()].filter((s) => s.deviceId === deviceId).map((s) => this.end(s)),
    );
    const session: Session = {
      id: randomBytes(16).toString('base64url'),
      deviceId,
      optionId: src.optionId,
      confirmed: false,
      positionMs: 0,
      adjacent: undefined,
      classified,
      title: dto.title,
      tracked: library?.item,
      media,
      mode: decision.mode,
      audioIndex: this.preferredAudio(media),
      subtitleIndex: this.preferredSubtitle(media),
      runCount: 0,
      run: undefined,
      lastActivity: this.now(),
      lastReport: this.now(),
      guest,
      alongside: guest || (decision.mode === 'copy' && src.takeover !== true),
      takeover: src.takeover === true,
      handedOver: false,
      ended: false,
      chain: Promise.resolve(),
    };
    this.sessions.set(session.id, session);
    try {
      const at = this.clamp(session, dto.startMs ?? library?.resumeMs ?? 0);
      session.positionMs = at;
      await this.serial(session, () => this.startRun(session, at, link));
    } catch (e) {
      await this.end(session);
      throw e;
    }
    library?.commit();
    session.adjacent = await this.neighborsFor(library?.item);
    this.logger.log(
      `Browser session started (${decision.mode}, ${media.audio.length} audio tracks, ${media.video?.codec})`,
    );
    return this.view(session);
  }

  /** The episodes around `item`, when it is one; empty on any failure. */
  private async neighborsFor(item: TrackedItem | undefined): Promise<AdjacentEpisodes | undefined> {
    if (!item || item.season === undefined || !this.options.adjacent) return undefined;
    try {
      return await this.options.adjacent.neighbors(item);
    } catch {
      return undefined;
    }
  }

  /**
   * Plays the next or previous episode of the same release in a new session of this device (the old
   * one ends at once). Previous starts from the beginning. Throws what the TV's next / previous
   * throws: no such episode, or no source from the same release.
   */
  async skip(
    id: string,
    deviceId: string,
    direction: 'next' | 'previous',
    caps: BrowserStartDto['caps'],
  ): Promise<BrowserSession> {
    const session = this.owned(id, deviceId);
    const item = session.tracked;
    if (!item || item.season === undefined || !this.options.adjacent) {
      throw new NoAdjacentEpisodeError(`There is no ${direction} episode`);
    }
    const found = await this.options.adjacent.find(item, releaseKey(session.classified), direction);
    return this.startSource(deviceId, {
      classified: this.streams.resolveOption(found.optionId),
      optionId: found.optionId,
      title: { type: 'series', id: found.videoId },
      caps,
      ...(direction === 'previous' ? { resume: false } : {}),
      ...(session.guest ? { guest: true } : {}),
    });
  }

  async seek(id: string, deviceId: string, positionMs: number): Promise<BrowserSession> {
    const session = this.owned(id, deviceId);
    session.positionMs = this.clamp(session, positionMs);
    await this.serial(session, () => this.startRun(session, this.clamp(session, positionMs)));
    return this.view(session);
  }

  /**
   * Plays another audio track: a new run at `positionMs` (default: where the current run began).
   * The choice is remembered for the next file, on the TV as well.
   */
  async setAudio(
    id: string,
    deviceId: string,
    index: number,
    positionMs?: number,
  ): Promise<BrowserSession> {
    const session = this.owned(id, deviceId);
    const track = session.media.audio[index];
    if (!track) throw new BadRequestException('No such audio track');
    session.audioIndex = index;
    if (!session.guest)
      this.options.choices?.setAudio({ language: track.language ?? '', name: track.title ?? '' });
    const at = positionMs ?? session.run?.startMs ?? 0;
    await this.serial(session, () => this.startRun(session, this.clamp(session, at)));
    return this.view(session);
  }

  /** Remembers the subtitle choice (`null` = off); the player shows the cues itself. */
  setSubtitle(id: string, deviceId: string, index: number | null): void {
    const session = this.owned(id, deviceId);
    if (index === null) return session.guest ? undefined : this.options.choices?.setSubtitle('off');
    const track = session.media.subtitles[index];
    if (!track) throw new BadRequestException('No such subtitle track');
    if (session.guest) return;
    this.options.choices?.setSubtitle({ language: track.language ?? '', name: track.title ?? '' });
  }

  private preferredAudio(media: ProbedMedia): number {
    const want = this.options.choices?.audio;
    const found =
      want &&
      matchStream(
        media.audio.map((a) => ({
          language: a.language ?? '',
          name: a.title ?? '',
          index: a.index,
        })),
        want,
      );
    return found ? found.index : media.audio.length ? 0 : -1;
  }

  private preferredSubtitle(media: ProbedMedia): number | undefined {
    const want = this.options.choices?.subtitle;
    if (!want || want === 'off') return undefined;
    return matchStream(
      media.subtitles.map((t) => ({
        language: t.language ?? '',
        name: t.title ?? '',
        index: t.index,
      })),
      want,
    )?.index;
  }

  /**
   * The browser reported a failure. Logged (the server otherwise never learns why a run was
   * restarted); a decode failure of copied video switches the session to converting, when that is
   * enabled, so the player's retry gets H.264 the browser can play.
   */
  playerError(
    id: string,
    deviceId: string,
    report: { kind: string; detail: string; positionMs: number; decode: boolean },
  ): void {
    const session = this.owned(id, deviceId);
    const run = session.run;
    this.logger.warn(
      `Player error (${session.mode}, run ${run?.n ?? '-'}, at ${Math.round(report.positionMs / 1000)} s): ` +
        `${report.kind}${report.detail ? `: ${report.detail}` : ''}`,
    );
    if (report.decode && session.mode === 'copy' && this.transcodeEnabled) {
      session.mode = 'transcode';
      this.logger.warn('The browser cannot decode the copied video: converting from the next run');
    }
  }

  /** The player's position, in the film's own time; saved to the library. */
  progress(id: string, deviceId: string, positionMs: number): void {
    const session = this.owned(id, deviceId);
    session.positionMs = positionMs;
    session.lastReport = this.now();
    if (session.confirmed) this.changed();
    if (!session.tracked || session.guest) return;
    this.options.progress?.save(session.tracked, positionMs, session.media.durationMs);
  }

  /**
   * The player of `id` really plays (its first `playing` event): from now on it is the household's
   * session. Returns false when the session is gone. The coordinator ends the others.
   */
  confirm(id: string, deviceId: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.ended || session.deviceId !== deviceId) return false;
    session.lastActivity = this.now();
    if (!session.confirmed) {
      session.confirmed = true;
      this.changed();
    }
    return true;
  }

  /** Ends every session but `keepId`; with `all` false, those playing alongside are left alone. */
  async endOthers(keepId: string, all = true): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => s.id !== keepId && (all || !s.alongside))
        .map((s) => this.end(s)),
    );
  }

  /** Ends every session (something else took over). */
  async endAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.end(s)));
  }

  /** A playing session (backend only); `only` or `except` a device's. */
  active({ only, except }: { only?: string; except?: string } = {}):
    ActiveBrowserSession | undefined {
    for (const s of this.sessions.values()) {
      if (!s.confirmed || s.ended) continue;
      if ((only !== undefined && s.deviceId !== only) || s.deviceId === except) continue;
      return {
        kind: 'browser',
        id: s.id,
        deviceId: s.deviceId,
        deviceName: this.options.deviceName?.(s.deviceId) ?? 'a device',
        optionId: s.optionId,
        classified: s.classified,
        title: s.title,
        tracked: s.tracked,
        positionMs: s.positionMs,
        durationMs: s.media.durationMs,
        guest: s.guest,
      };
    }
    return undefined;
  }

  /** True if session `id` is a guest's. */
  isGuest(id: string): boolean {
    return this.sessions.get(id)?.guest === true;
  }

  /** How session `id` treats the others when it starts playing; undefined if it is not this service's. */
  roleOf(id: string): { alongside: boolean; takeover: boolean } | undefined {
    const s = this.sessions.get(id);
    return s && { alongside: s.alongside, takeover: s.takeover };
  }

  /** A guest paired: its sessions are the household's from now on, so progress is saved. */
  markPaired(deviceId: string): void {
    for (const s of this.sessions.values()) if (s.deviceId === deviceId) s.guest = false;
  }

  /** Marks session `id` as sent to the TV; returns how to undo it. */
  handOver(id: string): (() => void) | undefined {
    const s = this.sessions.get(id);
    if (!s || s.ended) return undefined;
    s.handedOver = true;
    return () => {
      s.handedOver = false;
    };
  }

  /** The TV started something: sessions end, except those playing alongside not sent to the TV. */
  async endForTv(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => !s.alongside || s.handedOver)
        .map((s) => this.end(s)),
    );
  }

  /** Ends other devices' sessions whose player stopped reporting. */
  async endDeadOthers(deviceId: string): Promise<void> {
    const now = this.now();
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => s.deviceId !== deviceId && now - s.lastReport >= PLAYER_ALIVE_MS)
        .map((s) => this.end(s)),
    );
  }

  /** Called when the playing session appears, moves on or ends. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        this.logger.warn(`Session listener failed: ${(e as Error).message}`);
      }
    }
  }

  async endOwned(id: string, deviceId: string): Promise<void> {
    await this.end(this.owned(id, deviceId));
  }

  /** A revoked device loses its stream at once. */
  async endForDevice(deviceId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].filter((s) => s.deviceId === deviceId).map((s) => this.end(s)),
    );
  }

  /** The session of this device, or 404: another device's session looks the same as none. */
  private owned(id: string, deviceId: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.deviceId !== deviceId || session.ended) {
      throw new NotFoundException('No such browser session');
    }
    session.lastActivity = this.now();
    return session;
  }

  // ------------------------------------------------------------------------------- media

  /**
   * What the public media route may serve for `<session>/<run>/<file>`, or undefined (404) for an
   * unknown session, a run that is not the current one, or a name outside the allowlist. Counts
   * as activity, and as the player's progress when it is a segment.
   */
  async mediaFile(id: string, runNumber: number, file: string): Promise<MediaFile | undefined> {
    const session = this.sessions.get(id);
    const run = session?.run;
    if (!session || session.ended || !run || run.n !== runNumber || !MEDIA_FILE.test(file)) {
      return undefined;
    }
    session.lastActivity = this.now();
    const segment = SEGMENT_FILE.exec(file);
    if (segment) run.fetched = Math.max(run.fetched, Number(segment[1]));
    const contentType = CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1)] as string;
    // The init segment without edit lists, when it was written (`firstSegmentStart`).
    if (file === 'init.mp4' && run.playInit) {
      return { kind: 'file', root: run.dir, name: PLAY_INIT, contentType };
    }
    if (file === 'index.m3u8') {
      let body: string;
      try {
        body = await readFile(join(run.dir, file), 'utf8');
      } catch {
        return undefined;
      }
      // Start at the beginning of the growing playlist, not at the live edge.
      const tagged = body.includes('#EXT-X-START')
        ? body
        : body.replace(/^#EXTM3U\r?\n/, '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n');
      return { kind: 'playlist', body: tagged };
    }
    return { kind: 'file', root: run.dir, name: file, contentType };
  }

  // ------------------------------------------------------------------------------- runs

  private serial<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    const result = session.chain.then(fn, fn);
    session.chain = result.catch(() => undefined);
    return result;
  }

  private clamp(session: Session, positionMs: number): number {
    return Math.max(0, Math.min(positionMs, Math.max(0, session.media.durationMs - 5000)));
  }

  /**
   * Replaces the session's run by a new one starting at `positionMs`. The link comes from the
   * session's own source, so this works after the option id expired. Resolves once the first
   * segment exists.
   */
  private async startRun(
    session: Session,
    positionMs: number,
    link?: { id: string; url: string },
  ): Promise<void> {
    // A seek reads through the run's relay link: a fresh one from the provider costs seconds on
    // every seek (measured 5 s of a 10 s seek). Only when the new run cannot read it is one asked for.
    const reuse = link
      ? undefined
      : session.run && { id: session.run.relayId, url: session.run.relayUrl };
    if (!reuse) return this.runOnce(session, positionMs, link);
    try {
      await this.runOnce(session, positionMs, reuse, { keepRelay: true });
    } catch (e) {
      if (!(e instanceof StreamLinkError)) throw e;
      this.relay.forget(reuse.id);
      this.logger.log('The run could not read its link again: asking for a fresh one');
      await this.runOnce(session, positionMs, undefined);
    }
  }

  private async runOnce(
    session: Session,
    positionMs: number,
    link: { id: string; url: string } | undefined,
    { keepRelay = false }: { keepRelay?: boolean } = {},
  ): Promise<void> {
    await this.stopRun(session, { keepRelay });
    if (session.ended) throw new BrowserUnsupportedError('The session was ended');
    const { id: relayId, url } = link ?? (await this.freshLink(session));
    const n = ++session.runCount;
    const dir = join(this.options.mediaDir, session.id, String(n));
    await mkdir(dir, { recursive: true });
    const audio = session.media.audio[session.audioIndex];
    let child: ChildLike;
    try {
      child = this.options.spawn(
        'ffmpeg',
        buildRunArgs({
          url,
          startMs: positionMs,
          audioIndex: audio ? audio.index : -1,
          audioCodec: audio?.codecName ?? '',
          subtitleStreams: session.media.subtitles.map((t) => t.streamIndex),
          ...(session.mode === 'transcode' ? { transcode: this.transcodePlan(session) } : {}),
        }),
        { cwd: dir, env: minimalEnv() },
      );
    } catch {
      this.relay.forget(relayId);
      throw new BrowserUnavailableError('Browser playback is not available on this server');
    }
    const run: Run = {
      n,
      startMs: positionMs,
      dir,
      child,
      relayId,
      relayUrl: url,
      written: 0,
      fetched: -1,
      stopped: false,
      exited: false,
      killed: false,
      lastLines: [],
      playInit: false,
    };
    session.run = run;
    child.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split('\n').filter(Boolean)) {
        run.lastLines = [...run.lastLines, maskLine(line, [relayId])].slice(-5);
      }
    });
    let spawnFailed = false;
    child.on('error', (e) => {
      run.exited = true;
      spawnFailed = (e as NodeJS.ErrnoException).code === 'ENOENT';
    });
    child.on('exit', (code) => {
      run.exited = true;
      if (run.killed) return;
      if (code !== 0) this.logger.warn(`ffmpeg exited with ${code}: ${run.lastLines.join(' | ')}`);
      // A clean exit with warnings is usually a source that ended early (a dropped connection
      // ffmpeg could not reopen): the run is shorter than the film and the player stops early.
      else if (run.lastLines.length) {
        this.logger.warn(`ffmpeg finished with warnings: ${run.lastLines.join(' | ')}`);
      }
    });
    try {
      await this.waitForFirstSegment(session, run, () => spawnFailed);
    } catch (e) {
      await this.stopRun(session);
      throw e;
    }
    // A copy run starts at the keyframe before the position asked for, seconds earlier at times.
    // The player's clock and the subtitles must count from where it really starts.
    const actual = await this.firstSegmentStart(run);
    if (actual !== undefined && actual <= positionMs + 1000 && positionMs - actual < 60_000) {
      run.startMs = actual;
    }
    this.logger.log(
      `Run ${n} started at ${Math.round(run.startMs / 1000)} s (asked ${Math.round(positionMs / 1000)} s)`,
    );
  }

  private transcodePlan(session: Session): TranscodePlan {
    const config = this.options.transcode;
    const video = session.media.video;
    return {
      encoder: config?.mode === 'software' ? 'software' : 'vaapi',
      hwDecode: config?.hwDecode ?? false,
      device: config?.device ?? '/dev/dri/renderD129',
      tonemap: !!video && video.hdr !== 'none',
    };
  }

  /** A fresh relay link: from the session's source, else from the release in a new search. */
  private async freshLink(session: Session): Promise<{ id: string; url: string }> {
    try {
      return await this.streams.linkFor(session.classified, { name: '' });
    } catch (e) {
      if (!(e instanceof StreamLinkError) || !session.title) throw e;
      const key = releaseKey(session.classified);
      if (!key) throw e;
      // The provider dropped this link for good: find the same release again.
      const optionId = await this.streams.findMatching(session.title.type, session.title.id, key);
      if (!optionId) throw e;
      try {
        session.classified = this.streams.resolveOption(optionId);
      } catch (err) {
        if (err instanceof OptionExpiredError) throw e;
        throw err;
      }
      return this.streams.linkFor(session.classified, { name: '' });
    }
  }

  /** The film time at the run's `currentTime` 0, read from its first segment. */
  /**
   * Where the run really starts, read from the untouched init segment and the first segment. Also
   * writes the init segment the player gets: the same without edit lists (see `fmp4.ts`), before
   * the run is handed to the player, so the player never sees the original.
   */
  private async firstSegmentStart(run: Run): Promise<number | undefined> {
    let init: Buffer;
    let segment: Buffer;
    try {
      [init, segment] = await Promise.all([
        readFile(join(run.dir, 'init.mp4')),
        readFile(join(run.dir, 'seg0.m4s')),
      ]);
    } catch {
      return undefined;
    }
    const clean = withoutEditLists(init);
    if (clean) {
      try {
        await writeFile(join(run.dir, PLAY_INIT), clean);
        run.playInit = true;
      } catch (e) {
        this.logger.warn(`The player's init segment could not be written: ${(e as Error).message}`);
      }
    } else {
      this.logger.warn('The init segment could not be read: served as it is (Firefox may stall)');
    }
    return runStartMs(init, segment);
  }

  private async waitForFirstSegment(
    session: Session,
    run: Run,
    spawnFailed: () => boolean,
  ): Promise<void> {
    const deadline = this.now() + this.startTimeoutMs;
    for (;;) {
      if (session.ended || session.run !== run)
        throw new BrowserUnsupportedError('The session was ended');
      const playlist = await readFile(join(run.dir, 'index.m3u8'), 'utf8').catch(() => '');
      if (playlist.includes('#EXTINF')) {
        run.written = (await this.segments(run)).length;
        return;
      }
      if (spawnFailed()) {
        throw new BrowserUnavailableError('Browser playback is not available on this server');
      }
      if (run.exited) throw new StreamLinkError('unreachable', 'The source could not be read');
      if (this.now() > deadline) {
        throw new StreamLinkError('unreachable', 'The source took too long to start');
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /**
   * Kills the session's run, if any, and removes its files and its relay entry; `keepRelay` leaves
   * the entry for the next run to read.
   */
  private async stopRun(session: Session, { keepRelay = false } = {}): Promise<void> {
    const run = session.run;
    if (!run) return;
    session.run = undefined;
    run.killed = true;
    if (!run.exited) run.child.kill('SIGKILL'); // also ends a stopped process
    if (!keepRelay) this.relay.forget(run.relayId);
    await rm(run.dir, { recursive: true, force: true });
  }

  private async end(session: Session): Promise<void> {
    if (session.ended) return;
    session.ended = true;
    this.sessions.delete(session.id);
    if (session.confirmed) this.changed();
    await this.stopRun(session);
    await rm(join(this.options.mediaDir, session.id), { recursive: true, force: true });
    this.logger.log('Browser session ended');
  }

  private async segments(run: Run): Promise<number[]> {
    const names = await readdir(run.dir).catch(() => [] as string[]);
    return names.flatMap((name) => {
      const m = SEGMENT_FILE.exec(name);
      return m ? [Number(m[1])] : [];
    });
  }

  /**
   * Once a second: pauses `ffmpeg` when it is too far ahead of the player, resumes it, deletes what
   * the player is past, kills a run nobody fetches from, and ends a session nobody uses.
   */
  async tick(): Promise<void> {
    const now = this.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActivity > this.endIdleMs) {
        await this.end(session);
        continue;
      }
      const run = session.run;
      if (!run) continue;
      if (now - session.lastActivity > this.idleMs) {
        // The player went away or paused for good. The session stays; the next seek starts a run.
        this.logger.log('Run stopped: nothing fetched for a while');
        await this.stopRun(session);
        continue;
      }
      if (run.exited) continue; // finished: nothing left to pace
      const present = await this.segments(run);
      run.written = present.length ? Math.max(...present) + 1 : 0;
      const action = decideBackpressure({
        written: run.written,
        fetched: run.fetched,
        stopped: run.stopped,
        ahead: this.options.aheadSegments,
        behind: this.options.behindSegments,
      });
      if (action.signal) {
        run.child.kill(action.signal);
        run.stopped = action.signal === 'SIGSTOP';
      }
      await Promise.all(
        present
          .filter((n) => n < action.deleteBelow)
          .map((n) => rm(join(run.dir, `seg${n}.m4s`), { force: true })),
      );
    }
  }

  private view(session: Session): BrowserSession {
    const run = session.run as Run;
    return {
      id: session.id,
      handoffId: handoffIdOf(session.id),
      run: {
        n: run.n,
        startMs: run.startMs,
        playlistPath: `/media/${session.id}/${run.n}/index.m3u8`,
      },
      durationMs: session.media.durationMs,
      mode: session.mode,
      autoNext: this.options.autoNext ?? false,
      ...(session.adjacent && (session.adjacent.previous || session.adjacent.next)
        ? { adjacent: session.adjacent }
        : {}),
      ...(session.audioIndex >= 0 ? { audioIndex: session.audioIndex } : {}),
      ...(session.subtitleIndex !== undefined ? { subtitleIndex: session.subtitleIndex } : {}),
      audioTracks: session.media.audio.map((a) => {
        const track: BrowserAudioTrack = { ...a };
        delete (track as Partial<ProbedAudio>).codecName;
        return track;
      }),
      subtitleTracks: session.media.subtitles.map((t) => {
        const track: BrowserSubtitleTrack = { ...t };
        delete (track as Partial<ProbedSubtitle>).streamIndex;
        return track;
      }),
    };
  }

  /** The source and position of this device's session, to hand it to an external player. */
  sourceOf(
    id: string,
    deviceId: string,
  ): Pick<SourceStart, 'classified' | 'optionId' | 'title'> & { positionMs: number } {
    const session = this.owned(id, deviceId);
    return {
      classified: session.classified,
      ...(session.optionId ? { optionId: session.optionId } : {}),
      title: session.title,
      positionMs: session.positionMs,
    };
  }

  /** Whether video the browser cannot decode is converted (`TRANSCODE` is not `off`). */
  get transcodeEnabled(): boolean {
    return (this.options.transcode?.mode ?? 'off') !== 'off';
  }

  /** For tests: how many sessions exist. */
  get activeCount(): number {
    return this.sessions.size;
  }
}
