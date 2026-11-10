import { describe, expect, it } from 'vitest';
import { cueTextAt, parseVtt } from './webvtt.js';

describe('parseVtt', () => {
  it('reads cues in the short and the long time form', () => {
    const cues = parseVtt(
      'WEBVTT\n\n00:03.006 --> 00:05.006\nHello early\n\n1:02:03.500 --> 1:02:05.000 align:start\nLate\nSecond line\n',
    );
    expect(cues).toEqual([
      { start: 3.006, end: 5.006, text: 'Hello early' },
      { start: 3723.5, end: 3725, text: 'Late\nSecond line' },
    ]);
  });

  it('strips tags and ASS overrides, and skips what it does not understand', () => {
    const cues = parseVtt(
      'WEBVTT\n\nNOTE x\n\n1\n00:01.000 --> 00:02.000\n<i>{\\an8}Hi &amp; bye</i>\n\n00:09.000 --> 00:08.000\nbackwards\n\ngarbage --> here\nx\n\n00:03.000 --> 00:04.000\n<b></b>\n',
    );
    expect(cues).toEqual([{ start: 1, end: 2, text: 'Hi & bye' }]);
  });

  it('copes with CRLF and a cue cut off at the end of a growing file', () => {
    expect(parseVtt('WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nOne\r\n\r\n00:03.0')).toEqual([
      { start: 1, end: 2, text: 'One' },
    ]);
  });
});

describe('cueTextAt', () => {
  const cues = [
    { start: 1, end: 3, text: 'A' },
    { start: 2, end: 4, text: 'B' },
  ];
  it('shows every cue that is on, and none outside', () => {
    expect(cueTextAt(cues, 0.5)).toBe('');
    expect(cueTextAt(cues, 2.5)).toBe('A\nB');
    expect(cueTextAt(cues, 3)).toBe('B');
    expect(cueTextAt(cues, 4)).toBe('');
  });
});
