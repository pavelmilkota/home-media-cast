import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceCaps } from './device-caps.js';

afterEach(() => vi.unstubAllGlobals());

describe('deviceCaps', () => {
  it('asks for specific codec strings through MediaSource', () => {
    const asked: string[] = [];
    vi.stubGlobal('MediaSource', {
      isTypeSupported: (type: string) => {
        asked.push(type);
        return type.includes('avc1') || type.includes('hvc1.1.');
      },
    });
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(dynamic-range: high)' }));
    expect(deviceCaps()).toEqual({
      h264: true,
      hevc: true,
      hevc10: false,
      vp9: false,
      av1: false,
      hdr: true,
    });
    expect(asked.some((t) => t.includes('hvc1.2.4'))).toBe(true);
  });

  it('falls back to canPlayType (Safari) and treats a missing matchMedia as SDR', () => {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('matchMedia', undefined);
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type) => (type.includes('hvc1.2.4') ? 'probably' : ''));
    expect(deviceCaps()).toMatchObject({ h264: false, hevc10: true, hdr: false });
    spy.mockRestore();
  });

  it('reports nothing it cannot confirm', () => {
    vi.stubGlobal('MediaSource', undefined);
    expect(deviceCaps()).toEqual({
      h264: false,
      hevc: false,
      hevc10: false,
      vp9: false,
      av1: false,
      hdr: false,
    });
  });
});
