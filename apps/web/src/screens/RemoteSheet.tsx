import { Drawer } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useLive } from '../state/live.js';
import { RemotePanel } from './RemotePanel.js';

/** The full remote as a bottom sheet. Hidden while nothing plays; the parent drops the open request. */
export function RemoteSheet({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const active = useLive().status?.active === true;

  return (
    <Drawer.Backdrop isOpen={isOpen && active} onOpenChange={onOpenChange}>
      <Drawer.Content placement="bottom">
        <Drawer.Dialog aria-label={t('remote.title')}>
          <Drawer.Handle />
          <Drawer.CloseTrigger />
          <Drawer.Body>
            <RemotePanel />
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
