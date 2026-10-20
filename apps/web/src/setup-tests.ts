import '@testing-library/jest-dom/vitest';
import { toast } from '@heroui/react';
import { afterEach } from 'vitest';
import { i18n } from './i18n/index.js';

// Tests assert on English text whatever the machine's language is.
void i18n.changeLanguage('en');

// jsdom has no ResizeObserver; HeroUI Tabs measure their indicator with it.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
// ...and the Web Animations API it uses to wait for transitions.
Element.prototype.getAnimations ??= () => [];
// ...and window.scrollTo, which the router calls when restoring scroll.
window.scrollTo = () => {};
// ...and window.matchMedia, which the HeroUI toast region reads.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList;
// Toasts live in a module-level queue; keep one test's from showing in the next.
afterEach(() => toast.clear());
