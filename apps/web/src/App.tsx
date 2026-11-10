import { Tabs, Toast } from '@heroui/react';
import { Outlet, useLocation, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Sheet } from './router.js';
import { useToken } from './api/auth.js';
import { BrowserPlayerProvider, useBrowserPlayer } from './state/browser-player.js';
import { LiveProvider, useLive } from './state/live.js';
import { useQueue } from './state/queue.js';
import { BrowserPlayer } from './screens/BrowserPlayer.js';
import { useTakeover } from './screens/use-takeover.js';
import { ConnectionBar } from './screens/ConnectionBar.js';
import { PlaybackHistory } from './screens/PlaybackHistory.js';
import { MiniPlayer } from './screens/MiniPlayer.js';
import { GuestBootstrap } from './screens/GuestBootstrap.js';
import { PairingDialog } from './screens/PairingDialog.js';
import { RemoteSheet } from './screens/RemoteSheet.js';
import { SettingsSheet } from './screens/SettingsSheet.js';
import { trackEmbeddedBottomInset } from './state/embedded-inset.js';
import { useTvAccess } from './state/use-tv-access.js';

type Tab = 'home' | 'search' | 'library';
const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const TABS: { id: Tab; icon: ReactNode }[] = [
  { id: 'home', icon: icon('M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10') },
  { id: 'search', icon: icon('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4') },
  {
    id: 'library',
    icon: icon('M5 4v16M10 4v16M15.5 5l4 14.5M3 20h18'),
  },
];

function Shell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (l) => l.pathname });
  const sheetPush = useLocation({ select: (l) => l.state.sheetPush === true });
  const { sheet } = useSearch({ strict: false });
  const status = useLive().status;
  const player = useBrowserPlayer();
  const tvAccess = useTvAccess().state;
  useTakeover();
  const queued = useQueue().items.length > 0;
  const playing = status?.active === true || queued;
  const tab: Tab | '' =
    pathname === '/'
      ? 'home'
      : pathname === '/search'
        ? 'search'
        : pathname === '/library'
          ? 'library'
          : '';

  const openSheet = (next: Sheet) =>
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, sheet: next }),
      state: (prev) => ({ ...prev, sheetPush: true }),
    });
  const closeSheet = () => {
    // Opening pushed one entry; closing it by hand takes that entry back off.
    if (sheetPush) router.history.back();
    else
      void navigate({ to: '.', search: (prev) => ({ ...prev, sheet: undefined }), replace: true });
  };

  useEffect(() => trackEmbeddedBottomInset(), []);

  // A Remote link with nothing playing (reload, stale link, playback ended) drops the sheet
  // in place, so Back never reopens a dead sheet.
  useEffect(() => {
    // The remote is the TV's: a guest has no business there, whatever the link says.
    if (sheet === 'remote' && ((status && !status.active) || tvAccess !== 'allowed')) {
      void navigate({ to: '.', search: (prev) => ({ ...prev, sheet: undefined }), replace: true });
    }
  }, [sheet, status, tvAccess, navigate]);

  // The player lives at `?sheet=player` so Back closes it. It opens when a session appears, closing
  // it (Back included) ends the session, and a stale link with no session is dropped in place.
  const opened = useRef(false);
  useEffect(() => {
    if (player.session && !opened.current) {
      opened.current = true;
      openSheet('player');
    } else if (!player.session && opened.current) {
      opened.current = false;
      if (sheet === 'player') closeSheet();
    } else if (opened.current && sheet !== 'player') {
      opened.current = false;
      player.close();
    } else if (!player.session && sheet === 'player') {
      void navigate({ to: '.', search: (prev) => ({ ...prev, sheet: undefined }), replace: true });
    }
  }, [player.session, sheet]);

  return (
    <div
      className={`flex min-h-svh flex-col ${playing ? 'pb-[calc(156px+env(safe-area-inset-bottom))]' : 'pb-[calc(84px+env(safe-area-inset-bottom))]'}`}
    >
      <ConnectionBar onOpenSettings={() => openSheet('settings')} />
      <Outlet />
      {/* Anchored to the small viewport (`svh`), not `bottom-0`: Android browsers with a bottom toolbar
          (Brave) otherwise draw it over the bar. */}
      <div className="pointer-events-none fixed inset-x-0 top-0 flex h-svh flex-col items-center justify-end gap-2 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom)+var(--embed-bottom-inset,0px))] *:pointer-events-auto">
        <MiniPlayer onOpen={() => openSheet('remote')} />
        <div className="flex w-full max-w-105 items-center gap-2">
          <Tabs
            className="min-w-0 flex-1"
            selectedKey={tab}
            onSelectionChange={(key) =>
              void navigate({
                to: key === 'home' ? '/' : key === 'search' ? '/search' : '/library',
              })
            }
          >
            <Tabs.ListContainer className="w-full rounded-full border border-border bg-surface/90 shadow-lg backdrop-blur-md">
              <Tabs.List
                aria-label={t('tabs.sections')}
                className="grid w-full grid-cols-3 gap-1 rounded-full bg-transparent p-1.5"
              >
                {TABS.map((tab) => (
                  <Tabs.Tab
                    key={tab.id}
                    id={tab.id}
                    className="h-auto min-h-13 flex-col gap-0.5 rounded-full px-2 py-1.5 text-xs text-muted data-[selected=true]:font-semibold data-[selected=true]:text-accent-foreground"
                  >
                    {tab.icon}
                    <span>{t(`tabs.${tab.id}`)}</span>
                    <Tabs.Indicator className="rounded-full bg-accent shadow-none" />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <PlaybackHistory />
        </div>
      </div>
      <Toast.Provider placement="top" />
      <RemoteSheet isOpen={sheet === 'remote'} onOpenChange={(o) => !o && closeSheet()} />
      {player.session && sheet === 'player' && <BrowserPlayer onClose={player.close} />}
      <SettingsSheet isOpen={sheet === 'settings'} onOpenChange={(o) => !o && closeSheet()} />
      {/* Not a route: pairing from the player must leave the film (and `?sheet=player`) alone. */}
      <PairingDialog />
    </div>
  );
}

export function App() {
  const token = useToken();
  if (!token) return <GuestBootstrap />;
  return (
    <LiveProvider token={token}>
      <BrowserPlayerProvider>
        <Shell />
      </BrowserPlayerProvider>
    </LiveProvider>
  );
}
