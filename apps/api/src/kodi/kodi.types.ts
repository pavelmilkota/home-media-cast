export type KodiConnectionState = 'connected' | 'reconnecting' | 'unreachable';

export interface KodiNotification {
  method: string;
  params: unknown;
}

export interface KodiClientOptions {
  /** e.g. ws://127.0.0.1:9090/jsonrpc */
  url: string;
  requestTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Consecutive failed connection attempts before the state turns `unreachable`. */
  unreachableAfterFailures?: number;
}

export interface KodiClientEvents {
  state: (state: KodiConnectionState) => void;
  notification: (notification: KodiNotification) => void;
}

export type { KodiStream, PlayerStatus, SeekTarget } from '@home-media-cast/shared';
