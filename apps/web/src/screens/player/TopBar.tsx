import { Button, Dropdown, Label } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { BackGlyph, FullscreenGlyph, MoreGlyph, VolumeGlyph } from './glyphs.js';

const TARGET = 'size-14 min-h-14 min-w-14 text-white [&_svg]:size-8';

/** Back, the title, mute, fullscreen where the browser has it, and an overflow menu. */
export function TopBar({
  title,
  onBack,
  canFullscreen,
  fullscreen,
  onToggleFullscreen,
  onSendToTv,
  sendToTvDisabled,
  onOpenInPlayer,
  openInPlayerDisabled,
  onCopyLink,
  onMenuOpenChange,
  muted,
  onToggleMute,
}: {
  title: string;
  onBack: () => void;
  canFullscreen: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSendToTv: () => void;
  sendToTvDisabled: boolean;
  onOpenInPlayer: () => void;
  openInPlayerDisabled: boolean;
  onCopyLink: () => void;
  onMenuOpenChange: (open: boolean) => void;
  muted: boolean;
  onToggleMute: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="pointer-events-auto flex items-center gap-1 bg-linear-to-b from-black/70 to-transparent pt-[calc(0.5rem+env(safe-area-inset-top))] pr-[calc(0.5rem+env(safe-area-inset-right))] pb-6 pl-[calc(0.5rem+env(safe-area-inset-left))]"
      data-testid="top-bar"
    >
      <Button
        isIconOnly
        variant="ghost"
        className={TARGET}
        aria-label={t('player.close')}
        onPress={onBack}
      >
        <BackGlyph />
      </Button>
      <span className="min-w-0 flex-1 truncate px-1 text-base font-medium">{title}</span>
      <Button
        isIconOnly
        variant="ghost"
        className={TARGET}
        aria-label={muted ? t('player.unmute') : t('player.mute')}
        aria-pressed={muted}
        onPress={onToggleMute}
      >
        <VolumeGlyph muted={muted} />
      </Button>
      {canFullscreen && (
        <Button
          isIconOnly
          variant="ghost"
          className={TARGET}
          aria-label={fullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}
          onPress={onToggleFullscreen}
        >
          <FullscreenGlyph exit={fullscreen} />
        </Button>
      )}
      <Dropdown onOpenChange={onMenuOpenChange}>
        <Button isIconOnly variant="ghost" className={TARGET} aria-label={t('player.menu')}>
          <MoreGlyph />
        </Button>
        <Dropdown.Popover>
          <Dropdown.Menu
            onAction={(key) => {
              if (key === 'tv') onSendToTv();
              else if (key === 'external') onOpenInPlayer();
              else if (key === 'copy') onCopyLink();
            }}
            disabledKeys={[
              ...(sendToTvDisabled ? ['tv'] : []),
              ...(openInPlayerDisabled ? ['external', 'copy'] : []),
            ]}
          >
            <Dropdown.Item id="tv" textValue={t('handoff.sendToTv')}>
              <Label>{t('handoff.sendToTv')}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="external" textValue={t('external.open')}>
              <Label>{t('external.open')}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="copy" textValue={t('external.copyLink')}>
              <Label>{t('external.copyLink')}</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}
