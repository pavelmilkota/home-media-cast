import {
  MAX_TRANSCODE_HEIGHT,
  playbackMode,
  type DeviceCaps,
  type VideoFacts,
} from '@home-media-cast/shared';

export type ModeDecision = { mode: 'copy' | 'transcode' } | { mode: 'unsupported'; reason: string };

/**
 * How a source plays on a device, with the reason when it does not. The rule itself is
 * `playbackMode` in `packages/shared`, which the picker's label uses too, so the two cannot
 * disagree. `transcode` is false when conversion is switched off (`TRANSCODE=off`).
 */
export function decideMode(
  video: VideoFacts | undefined,
  caps: DeviceCaps,
  { transcode }: { transcode: boolean },
): ModeDecision {
  // `ffprobe` always finds a video stream, so facts are missing only when it said nothing useful.
  if (!video) return { mode: 'unsupported', reason: 'This video format cannot be played here' };
  const mode = playbackMode(video, caps, { transcode });
  if (mode !== 'unsupported') return { mode };
  if (video.height !== undefined && video.height > MAX_TRANSCODE_HEIGHT) {
    return {
      mode: 'unsupported',
      reason: `This device cannot play ${video.height}p video; it is not converted above ${MAX_TRANSCODE_HEIGHT}p`,
    };
  }
  return {
    mode: 'unsupported',
    reason: transcode
      ? 'This video cannot be played here'
      : 'This device cannot play this video as it is, and converting is switched off',
  };
}
