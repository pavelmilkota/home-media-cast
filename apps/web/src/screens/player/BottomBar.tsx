import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../../format.js';
import { CommitSlider } from '../CommitSlider.js';
import { NextGlyph, PreviousGlyph, TracksGlyph } from './glyphs.js';

const TARGET = 'size-14 min-h-14 min-w-14 text-white [&_svg]:size-8';

/** The seek bar with times, and below it the tracks button and the episode buttons. */
export function BottomBar({
  position,
  duration,
  seekDisabled,
  onSeek,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  skipDisabled,
  hasTracks,
  onOpenTracks,
}: {
  position: number;
  duration: number;
  seekDisabled: boolean;
  /** The slider was released at `ms`. */
  onSeek: (ms: number) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  skipDisabled: boolean;
  /** More than one audio track, or any subtitles. */
  hasTracks: boolean;
  onOpenTracks: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="pointer-events-auto grid gap-1 bg-linear-to-t from-black/70 to-transparent pt-8 pr-[calc(0.75rem+env(safe-area-inset-right))] pb-[calc(0.5rem+env(safe-area-inset-bottom))] pl-[calc(0.75rem+env(safe-area-inset-left))]"
      data-testid="bottom-bar"
    >
      <CommitSlider
        label={t('player.seek')}
        value={position}
        max={Math.max(1, duration)}
        step={1000}
        disabled={seekDisabled}
        tone="overlay"
        onCommit={onSeek}
      />
      <div className="flex items-center justify-between text-sm tabular-nums">
        <span>{formatTime(position)}</span>
        <span>{formatTime(duration)}</span>
      </div>
      {(hasPrevious || hasNext || hasTracks) && (
        <div className="flex items-center justify-between">
          <span className="flex gap-1">
            {hasPrevious && (
              <Button
                isIconOnly
                variant="ghost"
                className={TARGET}
                aria-label={t('player.previousEpisode')}
                isDisabled={skipDisabled}
                onPress={onPrevious}
              >
                <PreviousGlyph />
              </Button>
            )}
            {hasNext && (
              <Button
                isIconOnly
                variant="ghost"
                className={TARGET}
                aria-label={t('player.nextEpisode')}
                isDisabled={skipDisabled}
                onPress={onNext}
              >
                <NextGlyph />
              </Button>
            )}
          </span>
          {hasTracks && (
            <Button
              isIconOnly
              variant="ghost"
              className={TARGET}
              aria-label={t('player.tracks')}
              onPress={onOpenTracks}
            >
              <TracksGlyph />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
