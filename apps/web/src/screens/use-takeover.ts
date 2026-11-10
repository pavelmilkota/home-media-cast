import { toast } from '@heroui/react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBrowserPlayer } from '../state/browser-player.js';
import { useLive } from '../state/live.js';

/**
 * Closes this device's player when its session is taken: by another browser ("Continue here"
 * there) or by the TV ("Send to TV"). The server has already ended the session; a toast says where
 * it went. Nothing happens before the server has shown this session as the household's own.
 */
export function useTakeover(): void {
  const { t } = useTranslation();
  const { session, close } = useBrowserPlayer();
  const { browser, status } = useLive();
  const ownId = session?.info.handoffId;
  const seenOwn = useRef(false);

  useEffect(() => {
    if (!ownId) {
      seenOwn.current = false;
      return;
    }
    if (browser?.active && browser.handoffId === ownId) {
      seenOwn.current = true;
      return;
    }
    if (!seenOwn.current || browser === undefined) return;
    const where = browser.active
      ? browser.deviceName
      : status?.active
        ? t('handoff.theTv')
        : undefined;
    if (!where) return;
    seenOwn.current = false;
    toast(t('handoff.takenBy', { device: where }), { timeout: 6000 });
    close();
  }, [ownId, browser, status, close, t]);
}
