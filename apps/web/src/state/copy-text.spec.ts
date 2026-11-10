import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './copy-text.js';

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the clipboard API where there is one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await copyText('http://x/y');
    expect(writeText).toHaveBeenCalledWith('http://x/y');
  });

  it('falls back to the copy command without a secure context', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await copyText('http://x/y');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when the copy command is refused', async () => {
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    await expect(copyText('a')).rejects.toThrow();
  });
});
