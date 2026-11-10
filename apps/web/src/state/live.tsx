import type { BrowserStatus, KodiHealth, PlayerEvent, PlayerStatus } from '@home-media-cast/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { auth } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { connectEvents } from '../api/sse.js';

export interface Live {
  /** True while the event stream to the backend is open. */
  connected: boolean;
  status: PlayerStatus | undefined;
  kodi: KodiHealth | undefined;
  /** What plays in a browser, on any device; absent until the server says. */
  browser: BrowserStatus | undefined;
}

const LiveContext = createContext<Live>({
  connected: false,
  status: undefined,
  kodi: undefined,
  browser: undefined,
});
export const useLive = (): Live => useContext(LiveContext);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps `/api/events` open for as long as the device is paired, reconnecting with backoff. */
export function LiveProvider({ token, children }: { token: string; children: ReactNode }) {
  const [live, setLive] = useState<Live>({
    connected: false,
    status: undefined,
    kodi: undefined,
    browser: undefined,
  });

  useEffect(() => {
    const ctl = new AbortController();
    const apply = (e: PlayerEvent) =>
      setLive((prev) =>
        e.type === 'status'
          ? { ...prev, status: e.data }
          : e.type === 'browser'
            ? { ...prev, browser: e.data }
            : { ...prev, kodi: e.data },
      );

    void (async () => {
      let delay = 1000;
      while (!ctl.signal.aborted) {
        try {
          await connectEvents({
            token,
            signal: ctl.signal,
            onOpen: () => {
              delay = 1000;
              // A browser session that ended while disconnected is not replayed: start clean.
              setLive((prev) => ({ ...prev, connected: true, browser: undefined }));
            },
            onEvent: apply,
          });
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            auth.clear(); // revoked from another device
            return;
          }
        }
        if (ctl.signal.aborted) return;
        setLive((prev) => ({ ...prev, connected: false }));
        await sleep(delay);
        delay = Math.min(delay * 2, 10_000);
      }
    })();

    return () => ctl.abort();
  }, [token]);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}
