import { toast } from '@heroui/react';
import type { ExternalSession } from '@home-media-cast/shared';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  detectPlatform,
  externalPlayerLink,
  type ExternalLaunch,
} from '../state/external-player.js';
import { copyText } from '../state/copy-text.js';

type AppLink = Extract<ExternalLaunch, { kind: 'link' }>;

/** Opens a launch in the player's app. Needs the tap that led here. */
function launchNow(launch: AppLink): void {
  window.location.href = launch.href;
}

/**
 * "Open in player": asks the server for a session, then opens the player's link from
 * the tap itself. Browsers may refuse a launch that comes after a request, so the same link is also
 * kept as a button (`fallback`) to tap once more.
 */
export function useOpenInPlayer() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState<AppLink | undefined>();

  const open = useCallback(
    async (start: () => Promise<ExternalSession>, title: string) => {
      setBusy(true);
      setFallback(undefined);
      try {
        const session = await start();
        const launch = externalPlayerLink(
          detectPlatform(navigator.userAgent, navigator.maxTouchPoints),
          `${window.location.origin}/api${session.path}`,
          { title, positionMs: session.startMs },
        );
        if (launch.kind === 'copy') {
          try {
            await copyText(launch.url);
            toast.info(t('external.noPlayerCopied'), { timeout: 10_000 });
          } catch {
            toast.danger(t('external.copyFailed'), { timeout: 8000 });
          }
          return;
        }
        if (launch.alsoCopy) {
          // The Linux helper may not be installed: then nothing opens, and this is the way out.
          const copied = await copyText(launch.alsoCopy).then(
            () => true,
            () => false,
          );
          const hint = launch.hint ?? 'linux';
          toast.info(t(copied ? `external.${hint}Hint` : `external.${hint}HintNoCopy`), {
            timeout: 10_000,
          });
        }
        setFallback(launch);
        launchNow(launch);
      } catch (e) {
        toast.danger(e instanceof Error && e.message ? e.message : t('external.failed'), {
          timeout: 8000,
        });
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  /** Asks for a session like `open`, but puts the stream's address on the clipboard instead. */
  const copyLink = useCallback(
    async (start: () => Promise<ExternalSession>) => {
      setBusy(true);
      try {
        const session = await start();
        try {
          await copyText(`${window.location.origin}/api${session.path}`);
          toast.success(t('external.linkCopied'));
        } catch {
          toast.danger(t('external.copyFailed'), { timeout: 8000 });
        }
      } catch (e) {
        toast.danger(e instanceof Error && e.message ? e.message : t('external.failed'), {
          timeout: 8000,
        });
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return { busy, fallback, open, copyLink, dismiss: () => setFallback(undefined) };
}

/** The second chance: a plain link the person taps themselves. */
export function OpenInPlayerFallback({
  launch,
  onDismiss,
}: {
  launch: AppLink;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="status" className="grid gap-2 rounded-2xl border border-border p-3">
      <p className="text-sm text-muted">{t('external.openedHint')}</p>
      <div className="flex flex-wrap gap-2">
        <a className="button button--md button--secondary self-start" href={launch.href}>
          {t('external.open')}
        </a>
        {launch.playlist && (
          <a
            className="button button--md button--secondary self-start"
            href={launch.playlist.href}
            download={launch.playlist.filename}
          >
            {t('external.downloadPlaylist')}
          </a>
        )}
        {onDismiss && (
          <button
            type="button"
            className="button button--md button--ghost self-start"
            onClick={onDismiss}
          >
            {t('external.dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}
