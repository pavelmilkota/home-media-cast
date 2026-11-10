import { describe, expect, it } from 'vitest';
import { decideBackpressure, type BackpressureState } from './backpressure.js';

const base: BackpressureState = { written: 0, fetched: -1, stopped: false, ahead: 10, behind: 5 };
const decide = (s: Partial<BackpressureState>) => decideBackpressure({ ...base, ...s });

describe('decideBackpressure', () => {
  it('lets ffmpeg run while it is within the ahead budget', () => {
    expect(decide({ written: 10, fetched: -1 })).toEqual({ deleteBelow: 0 });
    expect(decide({ written: 20, fetched: 9 })).toEqual({ deleteBelow: 4 });
  });

  it('stops ffmpeg when it is more than the budget ahead of the player', () => {
    // Highest finished segment is 10, the player has fetched none: lead 11 > 10.
    expect(decide({ written: 11, fetched: -1 }).signal).toBe('SIGSTOP');
    expect(decide({ written: 30, fetched: 10 }).signal).toBe('SIGSTOP');
  });

  it('does not send a second stop to a process that is already stopped', () => {
    expect(decide({ written: 30, fetched: 10, stopped: true }).signal).toBeUndefined();
  });

  it('resumes only when the player has caught up half way', () => {
    // lead = written - 1 - fetched
    expect(decide({ written: 20, fetched: 10, stopped: true }).signal).toBeUndefined(); // lead 9
    expect(decide({ written: 16, fetched: 10, stopped: true }).signal).toBe('SIGCONT'); // lead 5
  });

  it('deletes only what is behind the margin', () => {
    expect(decide({ written: 30, fetched: 3 }).deleteBelow).toBe(0);
    expect(decide({ written: 30, fetched: 25, stopped: true }).deleteBelow).toBe(20);
  });
});
