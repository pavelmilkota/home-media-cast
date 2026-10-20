import { Button, Card, Drawer } from '@heroui/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api/client.js';
import { LOCALES, LOCALE_NAMES, language, useLanguage } from '../state/language.js';
import { useLive } from '../state/live.js';
import { ACCENTS, theme, useAccent } from '../state/theme.js';
import { sheet } from './ui.js';
import { CommitSlider } from './CommitSlider.js';
import { DevicesScreen } from './DevicesScreen.js';
import { SourceCacheCard } from './SourceCacheCard.js';

/** Devices and the volume, behind the gear. */
/** Swatch hue per accent preset; matches the hues in styles.css. */
const HUE: Record<(typeof ACCENTS)[number], number> = {
  mint: 165,
  blue: 254,
  green: 150,
  amber: 76,
  rose: 25,
  violet: 295,
};

export function SettingsSheet({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const lang = useLanguage();
  const { status } = useLive();
  const accent = useAccent();
  const [confirmRestart, setConfirmRestart] = useState(false);
  const tv = useMutation({
    mutationFn: (action: 'fullscreen' | 'home' | 'screensaver' | 'restart-kodi') =>
      api(`/tv/${action}`, { method: 'POST' }).then(() => action),
    onSuccess: (action) => {
      if (action === 'restart-kodi') setConfirmRestart(false);
    },
  });
  const volume = useMutation({
    mutationFn: (v: number) => api('/player/volume', { method: 'POST', body: { volume: v } }),
  });

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement="bottom">
        <Drawer.Dialog aria-label={t('settings.title')}>
          <Drawer.Handle />
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>{t('settings.title')}</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>
            <div className={sheet}>
              {status && (
                <Card>
                  <CommitSlider
                    label={t('settings.volume')}
                    showLabel
                    value={status.volume}
                    max={100}
                    display={(v) => `${v}%`}
                    onCommit={(v) => volume.mutate(v)}
                  />
                  {volume.isError && (
                    <p role="alert" className="text-danger">
                      {volume.error.message}
                    </p>
                  )}
                </Card>
              )}
              <Card>
                <Card.Title>{t('settings.tv')}</Card.Title>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    isDisabled={tv.isPending}
                    onPress={() => tv.mutate('home')}
                  >
                    {t('settings.kodiHome')}
                  </Button>
                  <Button
                    variant="secondary"
                    isDisabled={tv.isPending}
                    onPress={() => tv.mutate('fullscreen')}
                  >
                    {t('settings.toggleFullscreen')}
                  </Button>
                  <Button
                    variant="secondary"
                    isDisabled={tv.isPending}
                    onPress={() => tv.mutate('screensaver')}
                  >
                    {t('settings.startScreensaver')}
                  </Button>
                </div>
                {confirmRestart ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="danger-soft"
                      isDisabled={tv.isPending}
                      onPress={() => tv.mutate('restart-kodi')}
                    >
                      {t('settings.confirmRestart')}
                    </Button>
                    <Button variant="secondary" onPress={() => setConfirmRestart(false)}>
                      {t('settings.cancelRestart')}
                    </Button>
                  </div>
                ) : (
                  <Button variant="secondary" onPress={() => setConfirmRestart(true)}>
                    {t('settings.restartKodi')}
                  </Button>
                )}
                {tv.isSuccess && tv.data === 'restart-kodi' && (
                  <p className="text-muted" role="status">
                    {t('settings.restartRequested')}
                  </p>
                )}
                {tv.isError && (
                  <p role="alert" className="text-danger">
                    {tv.error.message}
                  </p>
                )}
              </Card>
              <Card>
                <Card.Title>{t('settings.accent')}</Card.Title>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label={t('settings.accent')}
                >
                  {ACCENTS.map((a) => (
                    <Button
                      key={a}
                      isIconOnly
                      variant="ghost"
                      className="size-10 min-w-10 rounded-full border-2 border-transparent aria-pressed:border-foreground aria-pressed:inset-ring-2 aria-pressed:inset-ring-surface"
                      style={{ background: `oklch(0.62 0.15 ${HUE[a]})` }}
                      aria-label={t(`settings.accents.${a}`)}
                      aria-pressed={accent === a}
                      onPress={() => theme.setAccent(a)}
                    />
                  ))}
                </div>
              </Card>
              <Card>
                <Card.Title>{t('settings.language')}</Card.Title>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label={t('settings.language')}
                >
                  <Button
                    size="sm"
                    variant={lang === 'auto' ? 'primary' : 'secondary'}
                    aria-pressed={lang === 'auto'}
                    onPress={() => language.set('auto')}
                  >
                    {t('settings.languageAuto')}
                  </Button>
                  {LOCALES.map((l) => (
                    <Button
                      key={l}
                      size="sm"
                      variant={lang === l ? 'primary' : 'secondary'}
                      aria-pressed={lang === l}
                      // The name is in its own language, so the screen reader must read it as such.
                      lang={l}
                      onPress={() => language.set(l)}
                    >
                      {LOCALE_NAMES[l]}
                    </Button>
                  ))}
                </div>
              </Card>
              <SourceCacheCard />
              <DevicesScreen />
            </div>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
