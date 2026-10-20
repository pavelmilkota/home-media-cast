import { z } from 'zod';

/** AIOStreams cannot be reached, or answered with a server error: a normal state (ADR-0005). */
export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
}

/** AIOStreams is not configured in `.env`. */
export class SourceNotConfiguredError extends Error {
  override readonly name = 'SourceNotConfiguredError';
}

/** AIOStreams refused our uuid/password. Messages never include them. */
export class SourceAuthError extends Error {
  override readonly name = 'SourceAuthError';
}

export interface AioStreamsOptions {
  url: string;
  uuid: string;
  password: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface AioSearchResult {
  /** The raw results; `classifyResult` reads what it needs and ignores the rest. */
  results: unknown[];
  /** Titles of per-source errors (one addon failing does not fail the search). */
  errors: string[];
}

export type TitleType = 'movie' | 'series';

/** `tt1234567`, or `tmdb:123`; series add `:season:episode`. Nothing else reaches the request. */
const ID = {
  movie: /^(tt\d{1,10}|tmdb:\d{1,10})$/,
  series: /^(tt\d{1,10}|tmdb:\d{1,10}):\d{1,3}:\d{1,4}$/,
} as const;

export const isValidTitleId = (type: TitleType, id: string): boolean => ID[type].test(id);

const Envelope = z.object({
  success: z.boolean(),
  error: z.object({ message: z.string().optional() }).nullable().optional(),
  data: z
    .object({
      results: z.array(z.unknown()),
      errors: z.array(z.object({ title: z.string().optional() })).optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Thin client for `GET /api/v1/search` (documented public API, `Authorization: Basic
 * base64(uuid:password)`). The credentials live in the header only: they are not part of any
 * URL, log line or error message this class produces.
 */
export class AioStreamsClient {
  private readonly base: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: AioStreamsOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.authorization = `Basic ${Buffer.from(`${options.uuid}:${options.password}`).toString('base64')}`;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async search(type: TitleType, id: string, signal?: AbortSignal): Promise<AioSearchResult> {
    if (!isValidTitleId(type, id)) throw new RangeError('Not a valid title id');
    const url = `${this.base}/api/v1/search?type=${type}&id=${encodeURIComponent(id)}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { Authorization: this.authorization, Accept: 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch {
      throw new SourceUnavailableError('AIOStreams is not reachable');
    }
    if (res.status === 401 || res.status === 403) {
      throw new SourceAuthError('AIOStreams refused the configured credentials');
    }
    if (!res.ok) throw new SourceUnavailableError(`AIOStreams answered ${res.status}`);
    const parsed = Envelope.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new SourceUnavailableError('AIOStreams sent an unreadable answer');
    const { success, data } = parsed.data;
    if (!success || !data) throw new SourceUnavailableError('AIOStreams could not search');
    return {
      results: data.results,
      errors: (data.errors ?? [])
        .map((e) => e.title ?? 'Unknown source error')
        .map((t) => t.slice(0, 80)),
    };
  }
}
