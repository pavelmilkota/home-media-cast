import { Button, Chip, Popover, toast } from '@heroui/react';
import type { PlayedItem } from '@home-media-cast/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { ageLabel } from '../format.js';
import { useHistory } from '../state/history.js';
import { useBrowserPlayer } from '../state/browser-player.js';
import { useLive } from '../state/live.js';
import { useEffectiveTarget } from '../state/play-target.js';
import { useHandoff } from './use-handoff.js';
import { useStartWatch } from './use-start-watch.js';

const START_TIMEOUT_MS = 20_000;

const clockIcon = (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path
      d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4.5l3 1.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** A button beside the tab bar that lists what was played lately and plays an entry again. */
export function PlaybackHistory({
  startTimeoutMs = START_TIMEOUT_MS,
}: {
  startTimeoutMs?: number;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { status } = useLive();
  const { items } = useHistory();
  const [open, setOpen] = useState(false);
  const { phase, begin, arm } = useStartWatch(
    status,
    () => void client.invalidateQueries({ queryKey: ['history'] }),
    startTimeoutMs,
  );

  // Where a replay goes follows this device's "Play on" choice, as a tap in the picker does.
  const target = useEffectiveTarget();
  const browser = useBrowserPlayer();
  const handoff = useHandoff();

  const replay = useMutation({
    mutationFn: (id: string) =>
      api(`/playback/history/${encodeURIComponent(id)}/play`, { method: 'POST' }),
    onMutate: begin,
    onSuccess: () => {
      arm();
      setOpen(false);
    },
    onError: (e) => {
      toast.danger(e.message || t('history.replayFailed'), { timeout: 8000 });
    },
  });

  // The API answers 202 once Kodi accepts the request; no player in time means it did not start.
  const [failedShown, setFailedShown] = useState(false);
  if (phase === 'failed' && !failedShown) {
    setFailedShown(true);
    toast.danger(t('history.replayFailed'), { timeout: 8000 });
  } else if (phase !== 'failed' && failedShown) {
    setFailedShown(false);
  }

  if (items.length === 0) return null;

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="secondary"
        aria-label={t('history.open')}
        className="h-auto min-h-16 shrink-0 flex-col gap-0.5 rounded-full border border-border bg-surface/90 px-4 py-1.5 text-xs text-muted shadow-lg backdrop-blur-md"
      >
        {clockIcon}
        <span>{t('history.button')}</span>
      </Button>
      <Popover.Content placement="top end" className="w-[min(92vw,26rem)]">
        <Popover.Dialog aria-label={t('history.title')}>
          <Popover.Heading className="mb-2 font-semibold">{t('history.title')}</Popover.Heading>
          <ul className="grid gap-1.5">
            {items.map((item) => (
              <li key={item.id}>
                <HistoryRow
                  item={item}
                  isDisabled={replay.isPending || handoff.busy}
                  onPress={() => {
                    if (target === 'tv') return replay.mutate(item.id);
                    setOpen(false);
                    // No release key to tell the dub by: the title page asks for a source instead.
                    void handoff.run('here', () =>
                      browser.replayHere(
                        item.id,
                        [item.name, item.label].filter(Boolean).join(' · '),
                      ),
                    );
                  }}
                />
              </li>
            ))}
          </ul>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

function HistoryRow({
  item,
  isDisabled,
  onPress,
}: {
  item: PlayedItem;
  isDisabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      isDisabled={isDisabled}
      aria-label={t('history.replay', { name: item.name, label: item.label ?? '' })}
      className="h-auto w-full items-center justify-start gap-3 rounded-2xl p-2 text-left whitespace-normal wrap-anywhere"
      onPress={onPress}
    >
      <span className="block aspect-2/3 w-12 shrink-0 overflow-hidden rounded-lg bg-default">
        {item.poster ? (
          <img
            src={item.poster}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="block size-full object-cover"
          />
        ) : (
          <span className="grid size-full place-items-center text-xl text-muted" aria-hidden="true">
            {item.name.slice(0, 1)}
          </span>
        )}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong className="line-clamp-1 leading-tight">{item.name}</strong>
        {item.label && <span className="line-clamp-1 text-xs text-muted">{item.label}</span>}
        <span className="flex flex-wrap gap-1">
          {item.resolution && (
            <Chip size="sm" variant="soft">
              {item.resolution}
            </Chip>
          )}
          {item.quality && (
            <Chip size="sm" variant="soft">
              {item.quality}
            </Chip>
          )}
        </span>
        <span className="line-clamp-1 text-xs text-muted">{item.releaseTitle}</span>
        <span className="text-xs text-muted">{ageLabel(item.playedAt)}</span>
      </span>
    </Button>
  );
}
