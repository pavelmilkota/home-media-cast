import { z } from 'zod';

export const PairingCompleteSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'The code is 6 digits'),
  deviceName: z.string().trim().min(1).max(60),
});
export type PairingCompleteDto = z.infer<typeof PairingCompleteSchema>;

export const GuestRegisterSchema = z.object({
  deviceName: z.string().trim().min(1).max(60),
});
export type GuestRegisterDto = z.infer<typeof GuestRegisterSchema>;

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
  /** A guest browses and plays only; pairing makes it a paired device that controls the TV. */
  kind: 'paired' | 'guest';
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

export const DeviceCapsSchema = z.strictObject({
  h264: z.boolean(),
  hevc: z.boolean(),
  hevc10: z.boolean(),
  vp9: z.boolean(),
  av1: z.boolean(),
  hdr: z.boolean(),
});

/** `POST /browser-play`. */
export const BrowserStartSchema = z.strictObject({
  /** An `id` from the list returned by `GET /titles/:type/:id/streams`. */
  optionId: z.string().min(1).max(64),
  /** The catalog title, so progress reaches the library and the next episode can be found. */
  title: z
    .strictObject({
      type: z.enum(['movie', 'series']),
      id: z.string().regex(/^tt\d{1,10}(:\d{1,3}:\d{1,4})?$/),
    })
    .optional(),
  caps: DeviceCapsSchema,
  /** `false` plays from the start, as on the TV. */
  resume: z.boolean().optional(),
  /** Where to start; defaults to the library's resume point, or 0. */
  startMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000)
    .optional(),
});
export type BrowserStartDto = z.infer<typeof BrowserStartSchema>;

/** `POST /browser-play/:id/seek`. */
export const BrowserSeekSchema = z.strictObject({
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000),
});
export type BrowserSeekDto = z.infer<typeof BrowserSeekSchema>;

/** `POST /browser-play/:id/progress`: where the player is, in the film's own time. */
export const BrowserProgressSchema = z.strictObject({
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000),
});
export type BrowserProgressDto = z.infer<typeof BrowserProgressSchema>;

/**
 * `POST /browser-play/:id/error`: what went wrong in the player, for the server log. `decode` says
 * the browser could not decode the stream; a copy session then converts from the next run on.
 */
export const BrowserPlayerErrorSchema = z.strictObject({
  kind: z.string().regex(/^[\w.-]{1,40}$/),
  detail: z
    .string()
    .max(200)
    .regex(/^[\w .,:;()/'"=+-]*$/),
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000),
  decode: z.boolean(),
});
export type BrowserPlayerErrorDto = z.infer<typeof BrowserPlayerErrorSchema>;

/** `POST /browser-play/external`: hand a listed source to an external player. */
export const ExternalStartSchema = z.strictObject({
  optionId: z.string().min(1).max(64),
  title: z
    .strictObject({
      type: z.enum(['movie', 'series']),
      id: z.string().regex(/^tt\d{1,10}(:\d{1,3}:\d{1,4})?$/),
    })
    .optional(),
  resume: z.boolean().optional(),
  startMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000)
    .optional(),
});
export type ExternalStartDto = z.infer<typeof ExternalStartSchema>;

/** `POST /browser-play/:id/external`: hand the playing browser session to an external player. */
export const ExternalFromSessionSchema = z.strictObject({
  startMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000)
    .optional(),
});
export type ExternalFromSessionDto = z.infer<typeof ExternalFromSessionSchema>;

/** A request that only needs to know what this device can decode. */
export const BrowserCapsSchema = z.strictObject({ caps: DeviceCapsSchema });
export type BrowserCapsDto = z.infer<typeof BrowserCapsSchema>;

/** `POST /playback/handoff/here`: take the active session to this device. */
export const HandoffHereSchema = BrowserCapsSchema;
export type HandoffHereDto = z.infer<typeof HandoffHereSchema>;

/** `POST /playback/handoff/tv`: send the browser session to the TV. */
export const HandoffTvSchema = z.strictObject({
  /** Where the sender is now; defaults to the last reported position. */
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000)
    .optional(),
});
export type HandoffTvDto = z.infer<typeof HandoffTvSchema>;

/**
 * The body of a 409 `handoff_pick_source`: the session cannot continue on its own (the release
 * cannot be told, or this device cannot play it), so the client opens the picker for the title.
 */
export interface HandoffPickSource {
  type: 'movie' | 'series';
  videoId: string;
  positionMs: number;
}

/** `POST /browser-play/:id/audio`: the audio stream to play, by its index in `audioTracks`. */
export const BrowserAudioSchema = z.strictObject({
  index: z.number().int().min(0).max(64),
  /** Where to continue; defaults to where the current run began. */
  positionMs: z
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000)
    .optional(),
});
export type BrowserAudioDto = z.infer<typeof BrowserAudioSchema>;

/** `POST /browser-play/:id/subtitle`: the subtitle track the household picked, or `null` for off. */
export const BrowserSubtitleSchema = z.strictObject({
  index: z.number().int().min(0).max(64).nullable(),
});
export type BrowserSubtitleDto = z.infer<typeof BrowserSubtitleSchema>;
