import { Tabs } from '@heroui/react';
import { Outlet, useLocation, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Sheet } from './router.js';
import { useToken } from './api/auth.js';
import { LiveProvider, useLive } from './state/live.js';
import { useQueue } from './state/queue.js';
import { ConnectionBar } from './screens/ConnectionBar.js';
import { MiniPlayer } from './screens/MiniPlayer.js';
import { PairingScreen } from './screens/PairingScreen.js';
import { RemoteSheet } from './screens/RemoteSheet.js';
import { SettingsSheet } from './screens/SettingsSheet.js';

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

  // A Remote link with nothing playing (reload, stale link, playback ended) drops the sheet
  // in place, so Back never reopens a dead sheet.
  useEffect(() => {
    if (sheet === 'remote' && status && !status.active) {
      void navigate({ to: '.', search: (prev) => ({ ...prev, sheet: undefined }), replace: true });
    }
  }, [sheet, status, navigate]);

  return (
    <div
      className={`flex min-h-dvh flex-col ${playing ? 'pb-[calc(156px+env(safe-area-inset-bottom))]' : 'pb-[calc(84px+env(safe-area-inset-bottom))]'}`}
    >
      <ConnectionBar onOpenSettings={() => openSheet('settings')} />
      <Outlet />
      <div className="pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-center gap-2 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] *:pointer-events-auto">
        <MiniPlayer onOpen={() => openSheet('remote')} />
        <Tabs
          className="w-full max-w-105"
          selectedKey={tab}
          onSelectionChange={(key) =>
            void navigate({ to: key === 'home' ? '/' : key === 'search' ? '/search' : '/library' })
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
      </div>
      <RemoteSheet isOpen={sheet === 'remote'} onOpenChange={(o) => !o && closeSheet()} />
      <SettingsSheet isOpen={sheet === 'settings'} onOpenChange={(o) => !o && closeSheet()} />
    </div>
  );
}

export function App() {
  const token = useToken();
  if (!token) return <PairingScreen />;
  return (
    <LiveProvider token={token}>
      <Shell />
    </LiveProvider>
  );
}
