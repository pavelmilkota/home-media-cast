import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger, NotFoundException } from '@nestjs/common';
import type { ExternalSession, ExternalStartDto } from '@home-media-cast/shared';
import type { TrackedItem } from '../catalog/watch-tracker.service.js';
import type { RelayService } from '../relay/relay.service.js';
import { StreamLinkError, type StreamsService } from '../sources/streams.service.js';
import {
  handoffIdOf,
  type ActiveBrowserSession,
  type BrowserProgressSink,
  type SourceStart,
} from './browser-session.service.js';
import { probeMedia, type SpawnFn } from './ffmpeg.js';
import { ReadTracker } from './read-tracker.js';

export interface ExternalSessionOptions {
  progress?: BrowserProgressSink;
  deviceName?: (deviceId: string) => string | undefined;
  /** Runs `ffprobe` for the length; without it (or without `ffprobe`) there is no position. */
  spawn?: SpawnFn;
  /** No request for this long: the session ends. */
  idleMs?: number;
  /** The most a session lives, whatever it does: the id stays in the player's history. */
  maxLifeMs?: number;
  /** A position is saved to the library only after this much sequential reading. */
  saveAfterMs?: number;
  /** Subtracted from the estimate; see `ReadTracker`. */
  marginMs?: number;
  tickMs?: number;
  now?: () => number;
}

interface Session {
  id: string;
  deviceId: string;
  classified: SourceStart['classified'];
  optionId: string | undefined;
  title: SourceStart['title'];
  tracked: TrackedItem | undefined;
  relayId: string;
  startMs: number;
  durationMs: number;
  tracker: ReadTracker | undefined;
  /** The first sequential read has been seen: this is the household's session. */
  confirmed: boolean;
  /** A guest's play: leaves nothing in the household's data and leaves the TV alone. */
  guest: boolean;
  /**
   * Plays next to the TV and other devices instead of taking over: a guest's play, or any play
   * that is not a handoff (an external player is never fed a converted stream).
   */
  alongside: boolean;
  /** A handoff ("Continue here"): on its first play it ends every other session and the TV. */
  takeover: boolean;
  /** A paired device sent it to the TV; it ends when the TV is seen to start. */
  handedOver: boolean;
  startedAt: number;
  lastRequest: number;
  lastSaved: number;
  lastPublished: number;
  ended: boolean;
  /** Open responses and where each stood, so ending the session can cut them off. */
  responses: Map<number, { res: ServerResponse; baseBytes: number }>;
}

/** An external player counts as reading for this long after its last request. */
export const READING_MS = 60_000;

const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

/** A file name for the URL; display only, so anything harmless will do. */
export function fileNameFor(title: string | undefined): string {
  const name = (title ?? '').replace(SAFE_NAME, '_').replace(/^[._]+|[._]+$/g, '');
  return name.slice(0, 80) || 'video';
}

/**
 * Hands a source to an external player (VLC and the like) over the LAN. The player gets a URL with
 * an unguessable session id, never the provider link; the bytes come through the relay with
 * `Range`. The position is estimated from which bytes the player asked for. Only the first
 * sequential read starts the session: until then whatever plays elsewhere keeps playing.
 */
export class ExternalSessionService {
  private readonly logger = new Logger(ExternalSessionService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly listeners: (() => void)[] = [];
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxLifeMs: number;
  private readonly saveAfterMs: number;
  private timer: NodeJS.Timeout | undefined;
  private reads = 0;
  /** Set by the coordinator: the first read of `id` happened. */
  onStarted: ((id: string) => Promise<void>) | undefined;
  /** Set by the module: see `BrowserSessionService.guestGate`. */
  guestGate: ((deviceId: string) => Promise<void>) | undefined;

  constructor(
    private readonly streams: StreamsService,
    private readonly relay: RelayService,
    private readonly options: ExternalSessionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.maxLifeMs = options.maxLifeMs ?? 12 * 3_600_000;
    this.saveAfterMs = options.saveAfterMs ?? 30_000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.endAll();
  }

  // ----------------------------------------------------------------------------- control

  /** Starts from a listed option. 410 (`OptionExpiredError`) if it is no longer listed. */
  startFromOption(
    deviceId: string,
    dto: ExternalStartDto,
    guest = false,
  ): Promise<ExternalSession> {
    return this.start(deviceId, {
      classified: this.streams.resolveOption(dto.optionId),
      optionId: dto.optionId,
      title: dto.title,
      ...(dto.startMs !== undefined ? { startMs: dto.startMs } : {}),
      ...(dto.resume !== undefined ? { resume: dto.resume } : {}),
      ...(guest ? { guest } : {}),
    });
  }

  async start(deviceId: string, src: Omit<SourceStart, 'caps'>): Promise<ExternalSession> {
    const guest = src.guest === true;
    if (guest) await this.guestGate?.(deviceId);
    const link = await this.streams.linkFor(src.classified, { name: '' });
    let durationMs = 0;
    if (this.options.spawn) {
      try {
        const media = await probeMedia(this.options.spawn, link.url, { relayIds: [link.id] });
        durationMs = media.durationMs;
      } catch {
        // No length, so no position estimate; the player still gets the file.
        this.logger.log('External play without a length: no position estimate');
      }
    }
    const prepared = await this.options.progress?.prepare({
      ...(src.optionId ? { optionId: src.optionId } : {}),
      ...(src.title ? { title: src.title } : {}),
      ...(src.resume !== undefined ? { resume: src.resume } : {}),
    });
    const library = guest && prepared ? { item: prepared.item, commit: () => undefined } : prepared;
    // A device plays in one external player at a time; other devices' sessions wait for the first read.
    await Promise.all(
      [...this.sessions.values()].filter((s) => s.deviceId === deviceId).map((s) => this.end(s)),
    );
    const size = this.relay.sizeOf(link.id);
    const startMs = Math.max(0, src.startMs ?? library?.resumeMs ?? 0);
    const now = this.now();
    const session: Session = {
      id: randomBytes(16).toString('base64url'),
      deviceId,
      classified: src.classified,
      optionId: src.optionId,
      title: src.title,
      tracked: library?.item,
      relayId: link.id,
      startMs,
      durationMs,
      tracker:
        size && durationMs > 0
          ? new ReadTracker({
              sizeBytes: size,
              durationMs,
              now: this.now,
              ...(this.options.marginMs !== undefined ? { marginMs: this.options.marginMs } : {}),
            })
          : undefined,
      confirmed: false,
      guest,
      alongside: guest || src.takeover !== true,
      takeover: src.takeover === true,
      handedOver: false,
      startedAt: now,
      lastRequest: now,
      lastSaved: 0,
      lastPublished: 0,
      ended: false,
      responses: new Map(),
    };
    this.sessions.set(session.id, session);
    library?.commit();
    this.logger.log('External session started');
    return {
      id: session.id,
      handoffId: handoffIdOf(session.id),
      path: `/media/${session.id}/file/${fileNameFor(src.classified.title)}`,
      startMs,
      durationMs,
    };
  }

  async endOwned(id: string, deviceId: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.deviceId !== deviceId) throw new NotFoundException('No such session');
    await this.end(session);
  }

  async endForDevice(deviceId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].filter((s) => s.deviceId === deviceId).map((s) => this.end(s)),
    );
  }

  /** Ends every session but `keepId`; with `all` false, those playing alongside are left alone. */
  async endOthers(keepId: string, all = true): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => s.id !== keepId && (all || !s.alongside))
        .map((s) => this.end(s)),
    );
  }

  async endAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.end(s)));
  }

  /** A playing external session (backend only); `only` or `except` a device's. */
  active({ only, except }: { only?: string; except?: string } = {}):
    ActiveBrowserSession | undefined {
    for (const s of this.sessions.values()) {
      if (!s.confirmed || s.ended) continue;
      if ((only !== undefined && s.deviceId !== only) || s.deviceId === except) continue;
      const estimate = s.tracker?.estimate();
      return {
        kind: 'external',
        id: s.id,
        deviceId: s.deviceId,
        deviceName: this.options.deviceName?.(s.deviceId) ?? 'a device',
        optionId: s.optionId,
        classified: s.classified,
        title: s.title,
        tracked: s.tracked,
        positionMs: estimate?.positionMs ?? s.startMs,
        durationMs: s.durationMs,
        approximate: true,
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

  /** A guest paired: its sessions are the household's from now on. */
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

  /** Ends other devices' sessions that nothing is reading any more. */
  async endDeadOthers(deviceId: string): Promise<void> {
    const now = this.now();
    await Promise.all(
      [...this.sessions.values()]
        .filter(
          (s) =>
            s.deviceId !== deviceId && s.responses.size === 0 && now - s.lastRequest >= READING_MS,
        )
        .map((s) => this.end(s)),
    );
  }

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

  // ------------------------------------------------------------------------------- media

  /**
   * Serves `GET`/`HEAD /media/:id/file/:name` for the session `id`. Answers 404 for an unknown or
   * ended session. A link the provider refuses is registered again once from the session's source.
   */
  async serve(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.ended || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'cache-control': 'no-store', 'content-length': '0' }).end();
      return;
    }
    session.lastRequest = this.now();

    const readId = ++this.reads;
    if (req.method === 'GET') {
      const start = /^bytes=(\d+)-/.exec(String(req.headers.range ?? ''))?.[1];
      const tracked = session.tracker?.start(readId, start ? Number(start) : 0) ?? true;
      if (tracked) {
        session.responses.set(readId, { res, baseBytes: res.socket?.bytesWritten ?? 0 });
        res.on('close', () => {
          session.responses.delete(readId);
          session.tracker?.end(readId);
        });
        await this.confirm(session);
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    let outcome = await this.relay.serve(req, res, session.relayId);
    if (outcome === 'dead' && !session.ended) {
      // The provider dropped the link: one fresh one from the source the session holds.
      try {
        const link = await this.streams.linkFor(session.classified, { name: '' });
        this.relay.forget(session.relayId);
        session.relayId = link.id;
        outcome = await this.relay.serve(req, res, session.relayId);
      } catch (e) {
        if (!(e instanceof StreamLinkError)) throw e;
      }
    }
    if (outcome !== 'served' && !res.headersSent) {
      res.writeHead(outcome === 'dead' ? 502 : 404, { 'content-length': '0' }).end();
    }
  }

  private async confirm(session: Session): Promise<void> {
    if (session.confirmed || session.ended) return;
    session.confirmed = true;
    try {
      await this.onStarted?.(session.id);
    } catch (e) {
      this.logger.warn(`Could not take over from the TV: ${(e as Error).message}`);
    }
    this.changed();
  }

  // -------------------------------------------------------------------------------- upkeep

  /** Once a second: position estimate, saving, publishing, and ending what nobody uses. */
  tick(): void {
    const now = this.now();
    for (const session of [...this.sessions.values()]) {
      // A player reads a whole film over one open response: that is not idle, however long it lasts.
      if (session.responses.size > 0) session.lastRequest = now;
      if (now - session.lastRequest > this.idleMs || now - session.startedAt > this.maxLifeMs) {
        void this.end(session);
        continue;
      }
      for (const [readId, open] of session.responses) {
        session.tracker?.sent(readId, (open.res.socket?.bytesWritten ?? 0) - open.baseBytes);
      }
      const estimate = session.tracker?.estimate();
      if (!estimate || !session.confirmed) continue;
      if (
        session.tracked &&
        !session.guest &&
        estimate.sequentialMs >= this.saveAfterMs &&
        now - session.lastSaved >= 5000
      ) {
        session.lastSaved = now;
        this.options.progress?.save(session.tracked, estimate.positionMs, session.durationMs);
      }
      if (now - session.lastPublished >= 5000) {
        session.lastPublished = now;
        this.changed();
      }
    }
  }

  private async end(session: Session): Promise<void> {
    if (session.ended) return;
    session.ended = true;
    this.sessions.delete(session.id);
    // The player's stream fails: the only way to stop an external player.
    for (const { res } of session.responses.values()) res.destroy();
    session.responses.clear();
    this.relay.forget(session.relayId);
    if (session.confirmed) this.changed();
    this.logger.log('External session ended');
  }

  /** For tests. */
  get activeCount(): number {
    return this.sessions.size;
  }
}
