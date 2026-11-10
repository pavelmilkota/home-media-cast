import { afterEach, describe, expect, it, vi } from 'vitest';
import { playTarget } from './play-target.js';

describe('play target', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    playTarget.reload();
  });

  it('starts unset and stores the choice', () => {
    expect(playTarget.get()).toBeUndefined();
    playTarget.set('browser');
    expect(playTarget.get()).toBe('browser');
    expect(localStorage.getItem('hmc.playTarget')).toBe('browser');
    playTarget.reload();
    expect(playTarget.get()).toBe('browser');
  });

  it('treats an unknown stored value as unset and tells subscribers about changes', () => {
    localStorage.setItem('hmc.playTarget', 'nonsense');
    playTarget.reload();
    expect(playTarget.get()).toBeUndefined();
    const listener = vi.fn();
    const off = playTarget.subscribe(listener);
    playTarget.set('browser');
    playTarget.set('browser');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('keeps the choice in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    playTarget.set('browser');
    expect(playTarget.get()).toBe('browser');
  });
});
