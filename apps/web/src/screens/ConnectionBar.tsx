import { Button, Chip } from '@heroui/react';
import type { HealthResponse } from '@home-media-cast/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api/client.js';
import { useLive } from '../state/live.js';
import { theme, useTheme, type Theme } from '../state/theme.js';

const glyph = (d: string) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
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
const MODE_ICON: Record<Theme, ReactNode> = {
  // Half-filled disc: follows the system.
  system: glyph('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 3v18'),
  light: glyph(
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ),
  dark: glyph('M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z'),
};

type Level = 'ok' | 'warn' | 'bad';
const COLOR = { ok: 'success', warn: 'warning', bad: 'danger' } as const;

function Dot({ level, label }: { level: Level; label: string }) {
  return (
    <Chip size="sm" variant="soft" color={COLOR[level]}>
      {label}
    </Chip>
  );
}

/** Backend and Kodi state at a glance. Health is polled; the event stream refines the Kodi part. */
export function ConnectionBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const live = useLive();
  const mode = useTheme();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthResponse>('/health', { auth: false }),
    refetchInterval: 10_000,
    retry: false,
  });

  const backendDown = health.isError && !live.connected;
  const kodi = live.kodi ?? health.data?.kodi;
  const kodiLevel: Level =
    kodi?.state === 'connected' ? 'ok' : kodi?.state === 'reconnecting' ? 'warn' : 'bad';

  return (
    <header
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] text-sm"
      aria-label={t('connection.label')}
    >
      <Dot
        level={backendDown ? 'bad' : live.connected ? 'ok' : 'warn'}
        label={
          backendDown
            ? t('connection.serverUnreachable')
            : live.connected
              ? t('connection.server')
              : t('connection.serverConnecting')
        }
      />
      <Dot
        level={backendDown || !kodi ? 'warn' : kodiLevel}
        label={
          backendDown || !kodi
            ? t('connection.kodiUnknown')
            : t('connection.kodi', { state: t(`connection.kodiStates.${kodi.state}`) })
        }
      />
      {health.data?.db === 'error' && <Dot level="bad" label={t('connection.databaseError')} />}
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        className="ml-auto"
        aria-label={t('connection.theme', { mode: t(`connection.themes.${mode}`) })}
        onPress={() => theme.cycle()}
      >
        {MODE_ICON[mode]}
      </Button>
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        aria-label={t('connection.settings')}
        onPress={onOpenSettings}
      >
        <span aria-hidden="true">⚙</span>
      </Button>
    </header>
  );
}
