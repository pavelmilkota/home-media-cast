import type { KodiHealth, PlayerEvent, PlayerStatus } from '@home-media-cast/shared';
import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  /** The query string, with its `?`, or an empty string. */
  query: string;
  body: unknown;
  authorization: string | undefined;
}

type Answer = { status: number; body?: unknown };
/** A fixed answer, or one computed per call (possibly later, to hold a request open). */
type Reply = Answer | ((call: Call) => Answer | Promise<Answer>);

const enc = new TextEncoder();

/** Stands in for the backend: stubs `fetch`, records calls, and streams SSE events on demand. */
export class FakeBackend {
  readonly calls: Call[] = [];
  /** Every `/api/events` request, in order. */
  eventRequests: Call[] = [];
  private routes = new Map<string, Reply>();
  private streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  eventsStatus = 200;

  constructor() {
    this.on('GET /streams/cache', { status: 200, body: { entries: 0 } });
    this.on('GET /logs/kodi', {
      status: 200,
      body: {
        available: true,
        lines: [
          '2026-10-22 21:30:00.000 T:1   info <general>: Starting Kodi',
          '2026-10-22 21:30:01.000 T:1   warning <general>: CFileCache::Process - read stalled',
          '2026-10-22 21:30:02.000 T:1   error <general>: Playback failed',
        ],
        truncated: false,
      },
    });
    this.on('GET /logs/app', {
      status: 200,
      body: {
        entries: [
          {
            time: '2026-10-22T21:30:01.000Z',
            level: 'warn',
            context: 'RelayService',
            message: 'Relay request failed: Upstream unreachable',
          },
          {
            time: '2026-10-22T21:30:02.000Z',
            level: 'error',
            context: 'KodiService',
            message: 'Kodi call timed out',
          },
        ],
      },
    });
    this.on('GET /playback/history', { status: 200, body: { items: [] } });
    this.on('GET /health', {
      status: 200,
      body: { status: 'ok', kodi: { state: 'connected', version: '13.5.0' }, db: 'ok' },
    });
  }

  install(): this {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(input, init),
    );
    return this;
  }

  /** Routes are keyed `"METHOD /path"` without the `/api` prefix. */
  on(route: string, reply: Reply): this {
    this.routes.set(route, reply);
    return this;
  }

  callsTo(route: string): Call[] {
    const [method, path] = route.split(' ');
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  push(event: PlayerEvent): void {
    const chunk = enc.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    for (const stream of this.streams) stream.enqueue(chunk);
  }

  pushStatus(status: PlayerStatus): void {
    this.push({ type: 'status', data: status });
  }

  pushKodi(kodi: KodiHealth): void {
    this.push({ type: 'kodi', data: kodi });
  }

  /** Ends every open event stream, as a dropped connection would. */
  dropStreams(): void {
    for (const stream of this.streams) stream.close();
    this.streams = [];
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = {
      method,
      path,
      query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get('authorization') ?? undefined,
    };
    this.calls.push(call);

    if (path === '/events') {
      this.eventRequests.push(call);
      if (this.eventsStatus !== 200) return new Response(null, { status: this.eventsStatus });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });
      this.streams.push(controller);
      init?.signal?.addEventListener('abort', () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    const reply = this.routes.get(`${method} ${path}`);
    if (!reply)
      return new Response(JSON.stringify({ message: `no route ${method} ${path}` }), {
        status: 404,
      });
    const { status, body } = typeof reply === 'function' ? await reply(call) : reply;
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export const idle = (volume = 50): PlayerStatus => ({ active: false, volume, muted: false });

export const playing = (
  over: Partial<Extract<PlayerStatus, { active: true }>> = {},
): PlayerStatus => ({
  active: true,
  playerId: 1,
  speed: 1,
  positionMs: 60_000,
  durationMs: 600_000,
  title: 'Big Buck Bunny',
  audioStreams: [
    { index: 0, name: 'AC3', language: 'eng' },
    { index: 1, name: 'AAC', language: 'rus' },
  ],
  currentAudioStream: 0,
  subtitles: [{ index: 0, name: 'SRT', language: 'eng' }],
  currentSubtitle: null,
  subtitleEnabled: false,
  volume: 40,
  muted: false,
  ...over,
});
