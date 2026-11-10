import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';

export interface RelayTarget {
  /** The provider's URL. It may carry a key; it never leaves this service. */
  url: string;
  /** Sent to the first host only, never to a host a redirect leads to. */
  headers?: Record<string, string>;
  /** Shown by Kodi as the item's name (the last path segment). Display only. */
  name?: string;
}

export interface RelayOptions {
  /** Validates a URL (the SSRF rules, with the provider hosts allowed) and returns it normalised. */
  check: (url: string) => Promise<string>;
  /** `http://127.0.0.1:<port>`: what Kodi is given. */
  baseUrl: string;
  ttlMs?: number;
  maxEntries?: number;
  maxRedirects?: number;
  upstreamTimeoutMs?: number;
  /** A running stream that delivers nothing for this long is treated as dropped and resumed. */
  stallMs?: number;
  /** How many times one response may be resumed from the provider before the client is cut off. */
  maxResumes?: number;
}

interface Meta {
  contentType: string;
  length: number | undefined;
}

interface Entry {
  target: RelayTarget;
  expiresAt: number;
  meta?: Meta;
}

const FORWARD = ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** True for a connection that comes from this machine. */
export const isLoopback = (address: string | undefined): boolean =>
  address !== undefined && LOOPBACK.has(address);

/** The provider link does not work (dead, expired, unreachable). The message names no URL. */
export class RelayLinkError extends Error {
  override readonly name = 'RelayLinkError';
  constructor(
    readonly reason: 'expired' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Kodi never receives a provider URL. It opens `http://127.0.0.1:<port>/api/relay/<id>` and
 * this service fetches the real URL on its behalf (ADR-0005, decided in the Stage 3 spike:
 * a TorBox CDN link carries the account's API key as its `token`). Only the opaque id is
 * ever visible to Kodi, its log and its database.
 *
 * Nothing here logs or returns a provider URL, in error messages included.
 */
export class RelayService {
  private readonly logger = new Logger(RelayService.name);
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxRedirects: number;
  private readonly upstreamTimeoutMs: number;
  private readonly stallMs: number;
  private readonly maxResumes: number;

  constructor(private readonly options: RelayOptions) {
    this.ttlMs = options.ttlMs ?? 12 * 3600_000;
    this.maxEntries = options.maxEntries ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
    this.stallMs = options.stallMs ?? 20_000;
    this.maxResumes = options.maxResumes ?? 3;
  }

  /** Registers a target and returns the URL for Kodi. Throws if the URL is not allowed. */
  async register(target: RelayTarget): Promise<{ id: string; url: string }> {
    const url = await this.options.check(target.url);
    this.sweep();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    const id = randomBytes(16).toString('base64url');
    this.entries.set(id, {
      target: { url, ...(target.headers ? { headers: target.headers } : {}) },
      expiresAt: Date.now() + this.ttlMs,
    });
    const name = target.name ? `/${encodeURIComponent(target.name.slice(0, 120))}` : '';
    return { id, url: `${this.options.baseUrl}/api/relay/${id}${name}` };
  }

  /**
   * Checks that the link works before Kodi is told to open it, so a dead link is reported to
   * the phone at once instead of after Kodi's timeout. Also fetches the size and type that
   * Kodi's many `HEAD` requests are answered from.
   */
  async preflight(id: string, signal?: AbortSignal): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new RelayLinkError('expired', 'The relay entry is gone');
    try {
      await this.metadata(entry, signal ?? new AbortController().signal);
    } catch (e) {
      throw new RelayLinkError(
        e instanceof UpstreamError && e.status === 410 ? 'expired' : 'unreachable',
        e instanceof UpstreamError && e.status === 410
          ? 'The source link has expired or was refused'
          : 'The source did not respond',
      );
    }
  }

  /**
   * Reads up to `length` bytes of the source from `start` (shorter at the end of the file), for
   * looking at a file's header without playing it. The URL goes through the same checks and
   * redirect handling as playback. A server that ignores `Range` is cut off after `length` bytes,
   * and one that cannot start in the middle is refused.
   */
  async readRange(
    target: RelayTarget,
    start: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    try {
      const url = await this.options.check(target.url);
      const up = await this.fetchUpstream(
        { url, ...(target.headers ? { headers: target.headers } : {}) },
        `bytes=${start}-${start + length - 1}`,
        signal ?? new AbortController().signal,
      );
      if (up.status === 416 || !up.body) {
        await up.body?.cancel().catch(() => undefined);
        return Buffer.alloc(0);
      }
      if (up.status === 200 && start > 0) {
        await up.body.cancel().catch(() => undefined);
        throw new UpstreamError(502, 'Upstream ignores Range');
      }
      const chunks: Buffer[] = [];
      let got = 0;
      const reader = up.body.getReader();
      while (got < length) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        got += value.length;
      }
      await reader.cancel().catch(() => undefined);
      return Buffer.concat(chunks).subarray(0, length);
    } catch {
      throw new RelayLinkError('unreachable', 'The source did not respond');
    }
  }

  /** Forgets an id (playback finished or replaced). */
  forget(id: string): void {
    this.entries.delete(id);
  }

  /** Serves `GET`/`HEAD /api/relay/:id` for Kodi. Answers only connections from this machine. */
  async handle(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    if (
      !isLoopback(req.socket.remoteAddress) ||
      !HOST_OK.test(req.headers.host ?? '') ||
      (req.method !== 'GET' && req.method !== 'HEAD')
    ) {
      return end(res, 404);
    }
    const outcome = await this.serve(req, res, id);
    if (outcome === 'gone') end(res, 404);
    else if (outcome === 'dead') end(res, 410);
  }

  /**
   * Streams entry `id` to `req`'s client, with `Range` and `HEAD`, and no check on who asks: the
   * caller decides that (the LAN media route, where the session id is the capability). Writes
   * nothing and returns `gone` for an unknown id, and `dead` when the provider refuses the link
   * before anything was sent, so the caller can register it again once. Anything else, including a
   * failed stream, is answered here.
   */
  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<'served' | 'gone' | 'dead'> {
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt < Date.now()) {
      this.entries.delete(id);
      return 'gone';
    }

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      if (req.method === 'HEAD') {
        const meta = await this.metadata(entry, abort.signal);
        res.writeHead(200, {
          'content-type': meta.contentType,
          'accept-ranges': 'bytes',
          ...(meta.length !== undefined ? { 'content-length': String(meta.length) } : {}),
        });
        res.end();
        return 'served';
      }
      const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      const asked = Date.now();
      const up = await this.fetchUpstream(entry.target, range, abort.signal);
      const firstByteMs = Date.now() - asked;
      const headers: Record<string, string> = {};
      for (const name of FORWARD) {
        const value = up.headers.get(name);
        if (value) headers[name] = value;
      }
      res.writeHead(up.status, headers);
      if (!up.body) {
        res.end();
        return 'served';
      }
      void this.pump(entry, up, res, abort.signal, firstByteMs);
      return 'served';
    } catch (e) {
      if (abort.signal.aborted) return 'served';
      if (e instanceof UpstreamError && e.status === 410 && !res.headersSent) return 'dead';
      const status = e instanceof UpstreamError ? e.status : 502;
      // The message is written by this class and never contains a URL.
      this.logger.warn(
        `Relay request failed: ${e instanceof UpstreamError ? e.message : 'upstream unreachable'}`,
      );
      if (!res.headersSent) end(res, status);
      else res.destroy();
      return 'served';
    }
  }

  /**
   * Copies the provider's body to the client. A provider connection that drops, or goes quiet for
   * `stallMs`, is continued from the next byte with a new `Range` request (the client never sees
   * it); a response that cannot be continued is cut so the player asks again by itself, rather
   * than hanging on a stream that will never deliver. Logs how fast each stream ran.
   */
  private async pump(
    entry: Entry,
    first: Response,
    res: ServerResponse,
    signal: AbortSignal,
    firstByteMs: number,
  ): Promise<void> {
    const total = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(first.headers.get('content-range') ?? '');
    const length = Number(first.headers.get('content-length')) || undefined;
    let next = total ? Number(total[1]) : first.status === 200 ? 0 : undefined;
    const last = total ? Number(total[2]) : first.status === 200 && length ? length - 1 : undefined;
    const startedAt = Date.now();
    let sent = 0;
    let resumes = 0;
    let slowest = 0;
    let reader = (first.body as ReadableStream<Uint8Array>).getReader();
    const finish = (how: string) => {
      const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const mbit = ((sent * 8) / 1e6 / seconds).toFixed(1);
      this.logger.log(
        `Relay stream ${how}: ${(sent / 1e6).toFixed(1)} MB in ${seconds.toFixed(1)} s ` +
          `(${mbit} Mbit/s), first byte ${firstByteMs} ms, longest wait ${slowest} ms, ` +
          `${resumes} resumes`,
      );
    };
    try {
      for (;;) {
        try {
          for (;;) {
            const waited = Date.now();
            const chunk = await readWithin(reader, this.stallMs);
            slowest = Math.max(slowest, Date.now() - waited);
            if (signal.aborted) return void finish('cancelled');
            if (chunk.done) {
              // Ending short of what was promised is a drop too.
              if (last !== undefined && next !== undefined && next <= last) {
                throw new Error('ended early');
              }
              res.end();
              return void finish('finished');
            }
            sent += chunk.value.length;
            if (next !== undefined) next += chunk.value.length;
            if (!res.write(chunk.value)) {
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.off('drain', done);
                  res.off('close', done);
                  resolve();
                };
                res.once('drain', done);
                res.once('close', done);
              });
              if (signal.aborted) return void finish('cancelled');
            }
          }
        } catch (e) {
          await reader.cancel().catch(() => undefined);
          if (signal.aborted) return void finish('cancelled');
          const why = e instanceof Error && e.message === 'stalled' ? 'stalled' : 'dropped';
          if (
            next === undefined ||
            last === undefined ||
            next > last ||
            resumes >= this.maxResumes
          ) {
            this.logger.warn(
              `Provider stream ${why} and cannot be continued: cutting the client off`,
            );
            res.destroy();
            return void finish('cut');
          }
          resumes++;
          this.logger.warn(`Provider stream ${why}: continuing from byte ${next} (${resumes})`);
          const again = await this.fetchUpstream(entry.target, `bytes=${next}-${last}`, signal);
          if (again.status !== 206 || !again.body) {
            await again.body?.cancel().catch(() => undefined);
            throw new Error('cannot resume', { cause: e });
          }
          reader = again.body.getReader();
        }
      }
    } catch {
      // A resume that failed too: nothing more can be done for this response.
      if (!res.destroyed) res.destroy();
      finish('cut');
    }
  }

  /** The size of the file behind `id`, once `preflight` has read it. */
  sizeOf(id: string): number | undefined {
    return this.entries.get(id)?.meta?.length;
  }

  /** Size and type, fetched once so Kodi's many `HEAD` requests never reach the provider. */
  private async metadata(entry: Entry, signal: AbortSignal): Promise<Meta> {
    if (entry.meta) return entry.meta;
    const up = await this.fetchUpstream(entry.target, 'bytes=0-0', signal);
    await up.body?.cancel().catch(() => undefined);
    const total = /\/(\d+)$/.exec(up.headers.get('content-range') ?? '')?.[1];
    const length = total ? Number(total) : Number(up.headers.get('content-length')) || undefined;
    entry.meta = {
      contentType: up.headers.get('content-type') ?? 'application/octet-stream',
      length,
    };
    return entry.meta;
  }

  /** Follows redirects by hand so that every hop passes the URL check. */
  private async fetchUpstream(target: RelayTarget, range: string | undefined, signal: AbortSignal) {
    let url = target.url;
    const firstOrigin = new URL(url).origin;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      if (hop > 0)
        url = await this.options.check(url).catch(() => {
          this.logger.warn('A redirect hop was refused by the URL check');
          throw new UpstreamError(502, 'Redirect to a blocked address');
        });
      const sameOrigin = new URL(url).origin === firstOrigin;
      // The timeout covers waiting for the answer only. A fetch signal also governs the body, so
      // a timer left running would cut every stream after `upstreamTimeoutMs`, mid-film.
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new DOMException('Upstream timed out', 'TimeoutError')),
        this.upstreamTimeoutMs,
      );
      const res = await fetch(url, {
        headers: {
          ...(sameOrigin ? target.headers : {}),
          ...(range ? { Range: range } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.any([signal, timeout.signal]),
      })
        .catch((e: Error) => {
          if (signal.aborted) throw e;
          this.logger.warn(`Source did not answer: ${e.name}`);
          throw new UpstreamError(e.name === 'TimeoutError' ? 504 : 502, 'Upstream unreachable');
        })
        .finally(() => clearTimeout(timer));
      if (REDIRECTS.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new UpstreamError(502, 'Redirect without a location');
        url = new URL(location, url).href;
        continue;
      }
      if (res.status === 200 || res.status === 206 || res.status === 416) return res;
      await res.body?.cancel().catch(() => undefined);
      this.logger.warn(`Source answered ${res.status}`);
      // 401/403/404/410 mean the link is dead or expired: say so, so the caller can refresh it.
      throw new UpstreamError(
        [401, 403, 404, 410].includes(res.status) ? 410 : 502,
        `Upstream answered ${res.status}`,
      );
    }
    throw new UpstreamError(502, 'Too many redirects');
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.entries) if (e.expiresAt < now) this.entries.delete(id);
  }
}

function end(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}

/** Reads the next chunk, or rejects with `stalled` if nothing arrives within `ms`. */
function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stalled')), ms);
    reader.read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('dropped'));
      },
    );
  });
}
