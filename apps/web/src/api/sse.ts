import type { PlayerEvent } from '@home-media-cast/shared';
import { ApiError } from './client.js';

/** Incremental parser for `text/event-stream`. Feed it chunks; it calls back per event. */
export function createSseParser(onEvent: (event: string, data: string) => void) {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue; // comment / keep-alive
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) onEvent(event, data.join('\n'));
    }
  };
}

export interface ConnectOptions {
  token: string;
  signal: AbortSignal;
  onOpen: () => void;
  onEvent: (event: PlayerEvent) => void;
  /** The server pings every 15 s; silence for longer than this means a dead connection. */
  idleTimeoutMs?: number;
}

/**
 * Reads `/api/events` with fetch so the bearer token travels in a header (EventSource cannot
 * set headers, and a token in the URL would reach logs). Resolves when the stream ends.
 */
export async function connectEvents(opts: ConnectOptions): Promise<void> {
  const { token, signal, onOpen, onEvent, idleTimeoutMs = 40_000 } = opts;
  const res = await fetch('/api/events', {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal,
  });
  if (res.status === 401) throw new ApiError(401, undefined, 'Not authorised');
  if (!res.ok || !res.body) throw new ApiError(res.status, undefined, 'Event stream unavailable');
  onOpen();

  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleTimeoutMs);
  };
  const decoder = new TextDecoder();
  const feed = createSseParser((event, data) => {
    if (event !== 'status' && event !== 'kodi') return; // ping and unknown events
    try {
      onEvent({ type: event, data: JSON.parse(data) } as PlayerEvent);
    } catch {
      /* ignore a malformed event rather than drop the stream */
    }
  });
  const reader = res.body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', stop);
  idle.signal.addEventListener('abort', stop);
  arm();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      arm();
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    if (signal.aborted) return;
    if (idle.signal.aborted) return; // treated as a normal end; the caller reconnects
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}
