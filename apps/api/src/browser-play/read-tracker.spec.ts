import { beforeEach, describe, expect, it } from 'vitest';
import { ReadTracker, nearEnd } from './read-tracker.js';

const SIZE = 10_000_000_000; // 10 GB
const DURATION = 7_200_000; // 2 h

describe('ReadTracker', () => {
  let clock: number;
  let tracker: ReadTracker;
  beforeEach(() => {
    clock = 0;
    tracker = new ReadTracker({
      sizeBytes: SIZE,
      durationMs: DURATION,
      now: () => clock,
      marginMs: 10_000,
    });
  });

  it('has no position before any read', () => {
    expect(tracker.estimate()).toBeUndefined();
  });

  it('follows a sequential read from the start of the file', () => {
    expect(tracker.start(1, 0)).toBe(true);
    clock = 20_000;
    tracker.sent(1, 100_000_000); // 1% of the file
    expect(tracker.estimate()).toEqual({ positionMs: 72_000 - 10_000, sequentialMs: 20_000 });
  });

  it('starts at the offset of a read that begins in the middle (a seek)', () => {
    tracker.start(1, 0);
    tracker.sent(1, 50_000_000);
    clock = 5_000;
    tracker.end(1); // the player seeks: the old read closes
    tracker.start(2, SIZE / 2);
    clock = 6_000;
    tracker.sent(2, 10_000_000);
    const e = tracker.estimate()!;
    expect(e.positionMs).toBeGreaterThan(3_600_000 - 10_000);
    expect(e.positionMs).toBeLessThan(3_600_000 + 10_000);
    expect(e.sequentialMs).toBe(1_000); // sequential time starts over after a seek
  });

  it('prefers the read that has run longest over a short probe', () => {
    tracker.start(1, 0);
    clock = 30_000;
    tracker.sent(1, 200_000_000);
    tracker.start(2, SIZE / 4); // a second connection, e.g. the player looking ahead
    clock = 31_000;
    tracker.sent(2, 1_000_000);
    expect(tracker.estimate()?.positionMs).toBeLessThan(200_000);
    expect(tracker.estimate()?.sequentialMs).toBe(31_000);
  });

  it('ignores a read near the end of the file, where players look for an index', () => {
    tracker.start(1, 0);
    clock = 40_000;
    tracker.sent(1, 300_000_000);
    expect(tracker.start(2, SIZE - 100_000)).toBe(false);
    tracker.sent(2, 99_000);
    tracker.end(2);
    expect(tracker.estimate()?.positionMs).toBeLessThan(300_000);
    expect(nearEnd(SIZE - 100_000, SIZE)).toBe(true);
    expect(nearEnd(SIZE / 2, SIZE)).toBe(false);
    // A small file: a tenth at most, so its first bytes are still playing.
    expect(nearEnd(0, 50_000)).toBe(false);
    expect(nearEnd(49_000, 50_000)).toBe(true);
  });

  it('keeps the last position after the read closes (a pause, or the player went away)', () => {
    tracker.start(1, SIZE / 10);
    clock = 90_000;
    tracker.sent(1, 20_000_000);
    tracker.end(1);
    clock = 500_000;
    const e = tracker.estimate()!;
    expect(e.positionMs).toBeGreaterThan(720_000);
    expect(e.sequentialMs).toBe(90_000); // not the time since
  });

  it('never goes below zero or past the end', () => {
    tracker.start(1, 0);
    tracker.sent(1, 1000);
    expect(tracker.estimate()?.positionMs).toBe(0);
    tracker.end(1);
    tracker.start(2, SIZE - 3_000_000);
    tracker.sent(2, 2_900_000);
    expect(tracker.estimate()?.positionMs).toBeLessThanOrEqual(DURATION);
  });

  it('gives no estimate when the length or the size is unknown', () => {
    const unknown = new ReadTracker({ sizeBytes: SIZE, durationMs: 0, now: () => 0 });
    unknown.start(1, 0);
    expect(unknown.estimate()).toBeUndefined();
  });
});
