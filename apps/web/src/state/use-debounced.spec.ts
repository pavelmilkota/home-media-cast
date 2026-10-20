import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebounced } from './use-debounced.js';

describe('useDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the value only after it has been still for the delay', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), {
      initialProps: { v: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ v: 'ab' });
    act(() => void vi.advanceTimersByTime(200));
    rerender({ v: 'abc' });
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBe('abc');
  });
});
