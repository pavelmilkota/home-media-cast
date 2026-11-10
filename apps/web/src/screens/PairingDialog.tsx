import { Drawer } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { closePairing, usePairingOpen } from '../state/pairing-dialog.js';
import { PairingForm } from './PairingScreen.js';
import { sheet } from './ui.js';

/**
 * Pairing from anywhere in the app, for a guest. It is a sheet, not a route, so a film that is
 * playing keeps playing. On success the same device becomes a paired one (the form replaces the
 * stored token) and the sheet closes.
 */
export function PairingDialog() {
  const { t } = useTranslation();
  const open = usePairingOpen();
  return (
    <Drawer.Backdrop isOpen={open} onOpenChange={(o) => !o && closePairing()}>
      <Drawer.Content placement="bottom">
        <Drawer.Dialog aria-label={t('pairing.title')}>
          <Drawer.Handle />
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>{t('pairing.title')}</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>
            <div className={sheet}>
              <p className="text-muted">{t('pairing.guestIntro')}</p>
              <PairingForm asGuest onPaired={closePairing} />
            </div>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
