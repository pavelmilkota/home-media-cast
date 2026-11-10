import type { BrowserSession, CatalogType } from '@home-media-cast/shared';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { auth } from '../api/auth.js';
import { api } from '../api/client.js';
import { deviceCaps } from './device-caps.js';
import { guestProgress } from './guest-progress.js';

export interface StartArgs {
  optionId: string;
  title: { type: CatalogType; id: string };
  /** Shown in the player. */
  name: string;
  /** `false` plays from the start. */
  resume?: boolean;
  startMs?: number;
}

export interface ActiveSession {
  name: string;
  info: BrowserSession;
  /** What local progress is kept under; absent when this device did not choose the video. */
  videoId?: string;
}

interface BrowserPlayer {
  session: ActiveSession | undefined;
  start: (args: StartArgs) => Promise<void>;
  /** A new run at `positionMs`; resolves when the new playlist exists. */
  seek: (positionMs: number) => Promise<void>;
  /** Plays another audio track: a new run at `positionMs`; resolves when its playlist exists. */
  setAudio: (index: number, positionMs: number) => Promise<void>;
  /** Tells the server which subtitle track was picked (`null` = off), to carry it to the next file. */
  rememberSubtitle: (index: number | null) => void;
  /** The player's first `playing`: tells the server this is the household's session now. */
  confirmStarted: () => void;
  /** "Continue here": takes the active session (TV or another browser); `name` titles the player. */
  continueHere: (name: string) => Promise<void>;
  /** "Send to TV": plays the browser session on the TV. */
  sendToTv: (positionMs?: number) => Promise<void>;
  /** Plays the next or previous episode of the same release; a new session replaces this one. */
  skip: (direction: 'next' | 'previous') => Promise<void>;
  /** Starts a play from the Recent list in this browser. */
  replayHere: (historyId: string, name: string) => Promise<void>;
  /** Saves the position. `keepalive` lets it finish while the page is going away. */
  saveProgress: (positionMs: number, opts?: { keepalive?: boolean }) => void;
  /** Ends the session on the server and closes the player. */
  close: () => void;
}

const Context = createContext<BrowserPlayer>({
  session: undefined,
  start: async () => undefined,
  seek: async () => undefined,
  setAudio: async () => undefined,
  rememberSubtitle: () => undefined,
  confirmStarted: () => undefined,
  skip: async () => undefined,
  replayHere: async () => undefined,
  continueHere: async () => undefined,
  sendToTv: async () => undefined,
  saveProgress: () => undefined,
  close: () => undefined,
});
export const useBrowserPlayer = (): BrowserPlayer => useContext(Context);

/**
 * The one browser playback session of this device. Lives above the router so navigating does not
 * stop the video. Starting a new one ends the previous one on the server.
 */
export function BrowserPlayerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ActiveSession | undefined>();
  const current = useRef<ActiveSession | undefined>(undefined);
  const set = useCallback((next: ActiveSession | undefined) => {
    current.current = next;
    setSession(next);
  }, []);

  const start = useCallback(
    async (args: StartArgs) => {
      const info = await api<BrowserSession>('/browser-play', {
        method: 'POST',
        body: {
          optionId: args.optionId,
          title: args.title,
          caps: deviceCaps(),
          ...(args.resume === false ? { resume: false } : {}),
          ...(args.startMs !== undefined ? { startMs: args.startMs } : {}),
        },
      });
      set({ name: args.name, info, videoId: args.title.id });
    },
    [set],
  );

  const seek = useCallback(
    async (positionMs: number) => {
      const active = current.current;
      if (!active) return;
      const info = await api<BrowserSession>(`/browser-play/${active.info.id}/seek`, {
        method: 'POST',
        body: { positionMs: Math.max(0, Math.round(positionMs)) },
      });
      // Closed, or replaced by another session, while the request was running.
      if (current.current?.info.id !== info.id) return;
      set({ ...active, info });
    },
    [set],
  );

  const setAudio = useCallback(
    async (index: number, positionMs: number) => {
      const active = current.current;
      if (!active) return;
      const info = await api<BrowserSession>(`/browser-play/${active.info.id}/audio`, {
        method: 'POST',
        body: { index, positionMs: Math.max(0, Math.round(positionMs)) },
      });
      if (current.current?.info.id !== info.id) return;
      set({ ...active, info });
    },
    [set],
  );

  const rememberSubtitle = useCallback((index: number | null) => {
    const active = current.current;
    if (!active) return;
    void api(`/browser-play/${active.info.id}/subtitle`, {
      method: 'POST',
      body: { index },
    }).catch(() => undefined);
  }, []);

  const skip = useCallback(
    async (direction: 'next' | 'previous') => {
      const active = current.current;
      if (!active) return;
      const target = active.info.adjacent?.[direction];
      const info = await api<BrowserSession>(`/browser-play/${active.info.id}/${direction}`, {
        method: 'POST',
        body: { caps: deviceCaps() },
      });
      // Closed, or replaced by another session, while the request was running.
      if (current.current?.info.id !== active.info.id) return;
      const videoId = target?.videoId ?? active.videoId;
      set({ name: target?.label ?? active.name, info, ...(videoId ? { videoId } : {}) });
    },
    [set],
  );

  const replayHere = useCallback(
    async (historyId: string, name: string) => {
      const info = await api<BrowserSession>(
        `/playback/handoff/replay/${encodeURIComponent(historyId)}`,
        { method: 'POST', body: { caps: deviceCaps() } },
      );
      // A history entry's id is the video's id.
      set({ name, info, videoId: historyId });
    },
    [set],
  );

  const confirmStarted = useCallback(() => {
    const active = current.current;
    if (!active) return;
    void api(`/browser-play/${active.info.id}/started`, { method: 'POST' }).catch(() => undefined);
  }, []);

  const continueHere = useCallback(
    async (name: string) => {
      const info = await api<BrowserSession>('/playback/handoff/here', {
        method: 'POST',
        body: { caps: deviceCaps() },
      });
      set({ name, info });
    },
    [set],
  );

  const sendToTv = useCallback(async (positionMs?: number) => {
    await api('/playback/handoff/tv', {
      method: 'POST',
      body: positionMs === undefined ? {} : { positionMs: Math.max(0, Math.round(positionMs)) },
    });
  }, []);

  const saveProgress = useCallback((positionMs: number, opts?: { keepalive?: boolean }) => {
    const active = current.current;
    const token = auth.get();
    if (!active || !token || !Number.isFinite(positionMs)) return;
    // The server keeps nothing of a guest's play, so the guest's own browser remembers it.
    if (auth.kind() === 'guest' && active.videoId) {
      guestProgress.save(active.videoId, positionMs, active.info.durationMs);
    }
    // `fetch` with `keepalive` and not `sendBeacon`: a beacon cannot carry the Authorization header.
    void fetch(`/api/browser-play/${active.info.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ positionMs: Math.max(0, Math.round(positionMs)) }),
      ...(opts?.keepalive ? { keepalive: true } : {}),
    }).catch(() => undefined);
  }, []);

  const close = useCallback(() => {
    const active = current.current;
    if (!active) return;
    set(undefined);
    void api(`/browser-play/${active.info.id}`, { method: 'DELETE' }).catch(() => undefined);
  }, [set]);

  const value = useMemo(
    () => ({
      session,
      start,
      seek,
      setAudio,
      rememberSubtitle,
      confirmStarted,
      skip,
      replayHere,
      continueHere,
      sendToTv,
      saveProgress,
      close,
    }),
    [
      session,
      start,
      seek,
      setAudio,
      rememberSubtitle,
      confirmStarted,
      skip,
      replayHere,
      continueHere,
      sendToTv,
      saveProgress,
      close,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
