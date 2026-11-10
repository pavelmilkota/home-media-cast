import { Button, Card, Spinner, Switch, Tabs } from '@heroui/react';
import type { AppLogEntry, AppLogResponse, KodiLogResponse } from '@home-media-cast/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { screen } from './ui.js';

export type LogTab = 'kodi' | 'app';
type Level = 'info' | 'warn' | 'error';
type Filter = 'all' | 'problems';

const AUTO_REFRESH_MS = 5000;

/** Kodi writes `2026-10-22 21:30:00.123 T:1234   error <general>: …`. */
const KODI_LEVEL = /^\S+\s+\S+\s+T:\d+\s+(\w+)\s/;

export function kodiLevel(line: string): Level {
  const word = KODI_LEVEL.exec(line)?.[1]?.toLowerCase();
  if (word === 'error' || word === 'fatal') return 'error';
  if (word === 'warning') return 'warn';
  return 'info';
}

const COLOR: Record<Level, string> = { info: '', warn: 'text-warning', error: 'text-danger' };

interface Row {
  key: string;
  level: Level;
  text: string;
}

const appRow = (e: AppLogEntry, i: number): Row => ({
  key: `${i}-${e.time}`,
  level: e.level,
  text: `${new Date(e.time).toLocaleTimeString([], { hour12: false })} ${e.level.toUpperCase()}${e.context ? ` [${e.context}]` : ''} ${e.message}`,
});

export function LogsScreen({
  tab,
  onTab,
  onBack,
}: {
  tab: LogTab;
  onTab: (tab: LogTab) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const [auto, setAuto] = useState(false);
  const refetchInterval = auto ? AUTO_REFRESH_MS : false;

  const kodi = useQuery({
    queryKey: ['logs', 'kodi'],
    queryFn: () => api<KodiLogResponse>('/logs/kodi'),
    enabled: tab === 'kodi',
    refetchInterval,
  });
  const app = useQuery({
    queryKey: ['logs', 'app'],
    queryFn: () => api<AppLogResponse>('/logs/app'),
    enabled: tab === 'app',
    refetchInterval,
  });
  const active = tab === 'kodi' ? kodi : app;

  const rows: Row[] =
    tab === 'kodi'
      ? (kodi.data?.lines ?? []).map((text, i) => ({
          key: String(i),
          level: kodiLevel(text),
          text,
        }))
      : (app.data?.entries ?? []).map(appRow);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.level !== 'info');
  const unavailable = tab === 'kodi' && kodi.data?.available === false;

  return (
    <div className={screen}>
      <Button variant="ghost" className="self-start" onPress={onBack}>
        {t('common.back')}
      </Button>
      <h1 className="text-xl font-semibold">{t('logs.title')}</h1>
      <Tabs selectedKey={tab} onSelectionChange={(key) => onTab(key === 'app' ? 'app' : 'kodi')}>
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('logs.tabs')}>
            <Tabs.Tab id="kodi">
              {t('logs.kodi')}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="app">
              {t('logs.app')}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-2" role="group" aria-label={t('logs.filter')}>
          {(['all', 'problems'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'primary' : 'secondary'}
              aria-pressed={filter === f}
              onPress={() => setFilter(f)}
            >
              {t(`logs.${f}`)}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={active.isFetching}
          onPress={() => void active.refetch()}
        >
          {t('logs.refresh')}
        </Button>
        <Switch isSelected={auto} onChange={setAuto}>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Content>{t('logs.autoRefresh')}</Switch.Content>
        </Switch>
      </div>
      {active.isError && (
        <p role="alert" className="text-danger">
          {active.error.message}
        </p>
      )}
      {active.isPending && !active.isError && <Spinner />}
      {unavailable && <p className="text-muted">{t('logs.unavailable')}</p>}
      {active.data && !unavailable && (
        <Card>
          {tab === 'kodi' && kodi.data?.truncated && (
            <p className="text-muted text-sm">{t('logs.truncated')}</p>
          )}
          {shown.length === 0 ? (
            <p className="text-muted">{t('logs.empty')}</p>
          ) : (
            <pre
              className="max-h-[60svh] overflow-auto font-mono text-xs whitespace-pre-wrap break-words"
              tabIndex={0}
              aria-label={t('logs.title')}
            >
              {shown.map((r) => (
                <div key={r.key} className={COLOR[r.level]}>
                  {r.text}
                </div>
              ))}
            </pre>
          )}
        </Card>
      )}
    </div>
  );
}
