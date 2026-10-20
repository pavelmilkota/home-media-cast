import { z } from 'zod';
import type { KodiHealth } from './index.js';

export interface KodiStream {
  index: number;
  name: string;
  language: string;
}

export type PlayerStatus =
  | { active: false; volume: number; muted: boolean }
  | {
      active: true;
      playerId: number;
      /** 0 = paused, 1 = playing; other values are fast-forward / rewind. */
      speed: number;
      positionMs: number;
      durationMs: number;
      /** Display title only. Never the raw file path, which may carry credentials. */
      title: string;
      audioStreams: KodiStream[];
      currentAudioStream: number | null;
      subtitles: KodiStream[];
      currentSubtitle: number | null;
      subtitleEnabled: boolean;
      volume: number;
      muted: boolean;
    };

export type SeekTarget =
  { positionMs: number } | { percentage: number } | { offsetSeconds: number };

/** Server-sent events on `/api/events`. */
export type PlayerEvent =
  { type: 'status'; data: PlayerStatus } | { type: 'kodi'; data: KodiHealth };

export const SeekSchema = z.union([
  z.strictObject({ positionMs: z.number().int().min(0) }),
  z.strictObject({ percentage: z.number().min(0).max(100) }),
  z.strictObject({ offsetSeconds: z.number().int().min(-86_400).max(86_400) }),
]);

export const VolumeSchema = z.strictObject({ volume: z.number().int().min(0).max(100) });
export const AudioSchema = z.strictObject({ index: z.number().int().min(0) });
export const SubtitleSchema = z.strictObject({
  index: z.union([z.number().int().min(0), z.literal('off')]),
});
export type VolumeDto = z.infer<typeof VolumeSchema>;
export type AudioDto = z.infer<typeof AudioSchema>;
export type SubtitleDto = z.infer<typeof SubtitleSchema>;
