import type { DeviceCaps, VideoFacts } from '@home-media-cast/shared';
import { describe, expect, it } from 'vitest';
import { decideMode } from './playback-mode.js';

const caps: DeviceCaps = {
  h264: true,
  hevc: false,
  hevc10: false,
  vp9: true,
  av1: false,
  hdr: false,
};
const v = (f: Partial<VideoFacts>): VideoFacts => ({ hdr: 'none', ...f });
const on = { transcode: true };
const off = { transcode: false };

describe('decideMode', () => {
  const table: [string, VideoFacts, Partial<DeviceCaps>, { transcode: boolean }, string][] = [
    ['H.264 the device decodes', v({ codec: 'h264', height: 1080 }), {}, on, 'copy'],
    ['4K H.264 the device decodes', v({ codec: 'h264', height: 2160 }), {}, on, 'copy'],
    ['VP9 the device decodes', v({ codec: 'vp9' }), {}, on, 'copy'],
    [
      'HEVC 10-bit on a device with it',
      v({ codec: 'hevc', bitDepth: 10 }),
      { hevc10: true },
      on,
      'copy',
    ],
    [
      'HEVC 10-bit without it, 1080p',
      v({ codec: 'hevc', bitDepth: 10, height: 1080 }),
      {},
      on,
      'transcode',
    ],
    [
      'HEVC 10-bit without it, 4K',
      v({ codec: 'hevc', bitDepth: 10, height: 2160 }),
      {},
      on,
      'unsupported',
    ],
    ['AV1 without it, 720p', v({ codec: 'av1', height: 720 }), {}, on, 'transcode'],
    ['MPEG-4 part 2 (AVI)', v({ codec: 'other', height: 480 }), {}, on, 'transcode'],
    ['unknown height', v({ codec: 'hevc' }), {}, on, 'transcode'],
    [
      'HDR10 on an SDR screen, 1080p',
      v({ codec: 'hevc', height: 1080, hdr: 'hdr10' }),
      { hevc: true },
      on,
      'transcode',
    ],
    [
      'HDR10 on an SDR screen, 4K',
      v({ codec: 'hevc', height: 2160, hdr: 'hdr10' }),
      { hevc: true },
      on,
      'unsupported',
    ],
    [
      'HDR10 on an HDR screen',
      v({ codec: 'hevc', height: 2160, hdr: 'hdr10' }),
      { hevc: true, hdr: true },
      on,
      'copy',
    ],
    [
      'Dolby Vision with fallback on an HDR screen',
      v({ codec: 'hevc', hdr: 'dv-fallback' }),
      { hevc: true, hdr: true },
      on,
      'copy',
    ],
    [
      'Dolby Vision with fallback on an SDR screen',
      v({ codec: 'hevc', height: 1080, hdr: 'dv-fallback' }),
      { hevc: true },
      on,
      'transcode',
    ],
    [
      'Dolby Vision without fallback',
      v({ codec: 'hevc', height: 1080, hdr: 'dv' }),
      { hevc: true, hdr: true },
      on,
      'transcode',
    ],
    [
      'Dolby Vision without fallback, 4K',
      v({ codec: 'hevc', height: 2160, hdr: 'dv' }),
      { hevc: true, hdr: true },
      on,
      'unsupported',
    ],
    ['conversion off, copyable', v({ codec: 'h264' }), {}, off, 'copy'],
    [
      'conversion off, needs converting',
      v({ codec: 'hevc', bitDepth: 10, height: 1080 }),
      {},
      off,
      'unsupported',
    ],
  ];

  it.each(table)('%s', (_name, video, extra, options, expected) => {
    expect(decideMode(video, { ...caps, ...extra }, options).mode).toBe(expected);
  });

  it('explains a refusal above 1080p and when conversion is off', () => {
    const big = decideMode(v({ codec: 'hevc', height: 2160 }), caps, on);
    expect(big).toMatchObject({ mode: 'unsupported', reason: expect.stringMatching(/2160p/) });
    const none = decideMode(v({ codec: 'hevc', height: 1080 }), caps, off);
    expect(none).toMatchObject({
      mode: 'unsupported',
      reason: expect.stringMatching(/switched off/),
    });
  });

  it('refuses when there are no video facts', () => {
    expect(decideMode(undefined, caps, on).mode).toBe('unsupported');
  });
});
