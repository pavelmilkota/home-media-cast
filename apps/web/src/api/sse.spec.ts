import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse.js';

describe('createSseParser', () => {
  const collect = () => {
    const events: [string, string][] = [];
    return { events, feed: createSseParser((e, d) => events.push([e, d])) };
  };

  it('parses an event split across chunks', () => {
    const { events, feed } = collect();
    feed('event: status\nda');
    feed('ta: {"a":1}\n');
    expect(events).toEqual([]);
    feed('\nevent: kodi\ndata: {"b":2}\n\n');
    expect(events).toEqual([
      ['status', '{"a":1}'],
      ['kodi', '{"b":2}'],
    ]);
  });

  it('handles CRLF, comments, default event name and multi-line data', () => {
    const { events, feed } = collect();
    feed(': keep-alive\r\n\r\ndata: one\r\ndata: two\r\n\r\n');
    expect(events).toEqual([['message', 'one\ntwo']]);
  });

  it('ignores blocks without data', () => {
    const { events, feed } = collect();
    feed('event: ping\n\n');
    expect(events).toEqual([]);
  });
});
