import { toast } from '@heroui/react';
import type { HandoffPickSource } from '@home-media-cast/shared';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.js';
import { useBrowserPlayer } from '../state/browser-player.js';
import { handoffPick, isPickType, titleIdOf } from '../state/handoff-pick.js';
import { useLive } from '../state/live.js';

/**
 * "Continue here" and "Send to TV". When the server cannot continue by itself (409
 * `handoff_pick_source`) the title page opens its picker at the same position instead.
 */
export function useHandoff() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const player = useBrowserPlayer();
  const { status, browser } = useLive();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (direction: 'here' | 'tv', action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (e) {
        const pick =
          e instanceof ApiError
            ? (e.payload?.['pick'] as HandoffPickSource | undefined)
            : undefined;
        if (
          e instanceof ApiError &&
          e.code === 'handoff_pick_source' &&
          pick &&
          isPickType(pick.type)
        ) {
          handoffPick.set({ ...pick, direction, ...(e.message ? { reason: e.message } : {}) });
          void navigate({
            to: '/title/$type/$id',
            params: { type: pick.type, id: titleIdOf(pick.videoId) },
          });
        } else {
          toast.danger(e instanceof Error && e.message ? e.message : t('handoff.failed'), {
            timeout: 8000,
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [navigate, t],
  );

  /** The title on the TV or in another browser, for the player's heading. */
  const nowPlaying =
    (status?.active ? status.media?.name : undefined) ??
    (browser?.active ? browser.media?.name : undefined);

  return {
    busy,
    /** Runs a handoff-like request; a 409 `handoff_pick_source` opens the picker for the title. */
    run,
    /** The TV plays something chosen from the catalog (or another device plays in a browser). */
    canContinueHere:
      !player.session && (status?.active ? !!status.media : browser?.active === true),
    /** A browser plays on another device, not this one. */
    elsewhere: !player.session && browser?.active === true ? browser : undefined,
    continueHere: () => run('here', () => player.continueHere(nowPlaying ?? t('common.untitled'))),
    sendToTv: (positionMs?: number) => run('tv', () => player.sendToTv(positionMs)),
  };
}
