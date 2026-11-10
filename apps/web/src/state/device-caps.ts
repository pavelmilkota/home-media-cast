import type { DeviceCaps } from '@home-media-cast/shared';

// Specific codec strings: a bare "video/mp4" says nothing about HEVC or 10-bit.
const H264 = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
const HEVC = 'video/mp4; codecs="hvc1.1.6.L120.90"';
const HEVC10 = 'video/mp4; codecs="hvc1.2.4.L120.90"';
const VP9 = 'video/mp4; codecs="vp09.00.40.08"';
const AV1 = 'video/mp4; codecs="av01.0.08M.08"';

/** Measures what this browser can decode. Safari answers through `canPlayType` or Managed MSE. */
export function deviceCaps(): DeviceCaps {
  const g = globalThis as {
    MediaSource?: { isTypeSupported?: (type: string) => boolean };
    ManagedMediaSource?: { isTypeSupported?: (type: string) => boolean };
    document?: Document;
    matchMedia?: (query: string) => { matches: boolean };
  };
  const video = g.document?.createElement('video');
  const can = (type: string): boolean => {
    if (g.MediaSource?.isTypeSupported?.(type)) return true;
    if (g.ManagedMediaSource?.isTypeSupported?.(type)) return true;
    const answer = video?.canPlayType?.(type) ?? '';
    return answer === 'probably' || answer === 'maybe';
  };
  let hdr = false;
  try {
    hdr = g.matchMedia?.('(dynamic-range: high)').matches === true;
  } catch {
    /* unsupported query */
  }
  return {
    h264: can(H264),
    hevc: can(HEVC),
    hevc10: can(HEVC10),
    vp9: can(VP9),
    av1: can(AV1),
    hdr,
  };
}
