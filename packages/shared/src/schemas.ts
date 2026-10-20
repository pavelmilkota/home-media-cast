import { z } from 'zod';

export const PairingCompleteSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'The code is 6 digits'),
  deviceName: z.string().trim().min(1).max(60),
});
export type PairingCompleteDto = z.infer<typeof PairingCompleteSchema>;

export interface PairingCompleteResponse {
  deviceId: string;
  /** Shown once. The server stores only its hash. */
  token: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** True for the device that made the request. */
  current: boolean;
}

export const PlaybackSchema = z.object({
  kind: z.literal('direct_url'),
  url: z.string().trim().min(1).max(4096),
  /** Start from Kodi's saved resume point, if it has one. */
  resume: z.boolean().optional(),
});
export type PlaybackDto = z.infer<typeof PlaybackSchema>;

export const YoutubeCastSchema = z.object({ enabled: z.boolean() });
export type YoutubeCastDto = z.infer<typeof YoutubeCastSchema>;

/** The YouTube "Cast" receiver (ADR-0003, ADR-0007). */
export interface YoutubeCastStatus {
  /** The switch: should the receiver run? */
  enabled: boolean;
  /** Is it actually advertising on the network? False while off or after a failed start. */
  running: boolean;
  /** Name shown in the YouTube app's Cast menu. */
  deviceName: string;
  /** Why the last start failed, if it did. */
  error?: string;
}

export const YoutubePlaybackSchema = z.object({
  url: z.string().trim().min(1).max(4096),
});
export type YoutubePlaybackDto = z.infer<typeof YoutubePlaybackSchema>;

export const StreamPlaySchema = z.object({
  /** An `id` from the list returned by `GET /titles/:type/:id/streams`. */
  optionId: z.string().min(1).max(64),
  /**
   * The catalog title being watched (movie `tt…`, or an episode `tt…:1:2`). When present the
   * backend records progress for the library.
   */
  /** Start where the library says this title was left off (default true). */
  resume: z.boolean().optional(),
  title: z
    .strictObject({
      type: z.enum(['movie', 'series']),
      id: z.string().regex(/^tt\d{1,10}(:\d{1,3}:\d{1,4})?$/),
    })
    .optional(),
});
export type StreamPlayDto = z.infer<typeof StreamPlaySchema>;
