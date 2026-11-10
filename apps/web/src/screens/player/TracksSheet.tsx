import { Button } from '@heroui/react';
import type { BrowserAudioTrack, BrowserSubtitleTrack } from '@home-media-cast/shared';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

/** "UKR · EAC3 · 6ch": what tells one track from another. */
export function trackLabel(
  t: TFunction,
  track: { index: number; language?: string; title?: string; codec?: string; channels?: number },
): string {
  return (
    [
      track.language?.toUpperCase(),
      track.title ?? track.codec,
      track.channels ? `${track.channels}ch` : '',
    ]
      .filter(Boolean)
      .join(' · ') || t('player.track', { n: track.index + 1 })
  );
}

/** One list of exclusive choices: a radio group of full-width rows, the chosen one ticked. */
function ChoiceList({
  label,
  options,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  options: { id: string; name: string }[];
  selected: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid content-start gap-2">
      <h3 className="text-sm font-semibold text-muted">{label}</h3>
      <div role="radiogroup" aria-label={label} className="grid gap-1.5">
        {options.map((o) => {
          const on = o.id === selected;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => !on && onChange(o.id)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                on
                  ? 'border-accent bg-accent/15 font-semibold'
                  : 'border-border bg-transparent hover:bg-default'
              }`}
            >
              <span
                aria-hidden="true"
                className={`grid size-5 shrink-0 place-content-center rounded-full border-2 ${
                  on ? 'border-accent bg-accent text-accent-foreground' : 'border-border'
                }`}
              >
                {on && (
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m5 12 5 5 9-10" />
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1 break-words">{o.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Audio and subtitles as two lists in a sheet over the picture. It is part of the player's element
 * (not a portal), so it stays visible in fullscreen. Audio is only offered when there is a choice.
 */
export function TracksSheet({
  audioTracks,
  subtitleTracks,
  audioIndex,
  subtitleIndex,
  disabled,
  onAudio,
  onSubtitle,
  onClose,
}: {
  audioTracks: BrowserAudioTrack[];
  subtitleTracks: BrowserSubtitleTrack[];
  audioIndex: number;
  /** `null` = subtitles off. */
  subtitleIndex: number | null;
  disabled: boolean;
  onAudio: (index: number) => void;
  onSubtitle: (index: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col justify-end bg-black/50"
      onClick={onClose}
      data-testid="tracks-backdrop"
    >
      <div
        role="dialog"
        aria-label={t('player.tracks')}
        className="max-h-[80%] overflow-y-auto rounded-t-3xl bg-surface p-4 pr-[calc(1rem+env(safe-area-inset-right))] pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('player.tracks')}</h2>
          <Button variant="ghost" className="min-h-11" onPress={onClose}>
            {t('player.done')}
          </Button>
        </div>
        <div className="grid gap-4 landscape:grid-cols-2">
          {audioTracks.length > 1 && (
            <ChoiceList
              label={t('player.audio')}
              options={audioTracks.map((a) => ({ id: String(a.index), name: trackLabel(t, a) }))}
              selected={String(audioIndex)}
              disabled={disabled}
              onChange={(id) => onAudio(Number(id))}
            />
          )}
          {subtitleTracks.length > 0 && (
            <ChoiceList
              label={t('player.subtitles')}
              options={[
                { id: 'off', name: t('player.subtitlesOff') },
                ...subtitleTracks.map((s) => ({ id: String(s.index), name: trackLabel(t, s) })),
              ]}
              selected={subtitleIndex === null ? 'off' : String(subtitleIndex)}
              onChange={(id) => onSubtitle(id === 'off' ? null : Number(id))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
