import { afterEach, describe, expect, it } from 'vitest';
import { theme } from './theme.js';

const root = document.documentElement;

describe('theme', () => {
  afterEach(() => {
    localStorage.clear();
    theme.setAccent('mint');
    while (theme.get() !== 'system') theme.cycle();
  });

  it('cycles system, light, dark and marks the root', () => {
    theme.cycle();
    expect(theme.get()).toBe('light');
    expect(root).toHaveAttribute('data-theme', 'light');
    theme.cycle();
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root).toHaveClass('dark');
    theme.cycle();
    expect(root).not.toHaveAttribute('data-theme');
    expect(localStorage.getItem('hmc.theme')).toBe('system');
  });

  it('sets the accent preset and leaves mint without an attribute', () => {
    theme.setAccent('blue');
    expect(root).toHaveAttribute('data-accent', 'blue');
    expect(localStorage.getItem('hmc.accent')).toBe('blue');
    theme.setAccent('mint');
    expect(root).not.toHaveAttribute('data-accent');
  });
});
