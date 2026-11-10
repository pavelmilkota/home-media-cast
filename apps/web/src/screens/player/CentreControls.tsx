import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { PauseIcon, PlayIcon } from '../icons.js';
import { SeekGlyph } from './glyphs.js';

const SKIPS = [
  { seconds: 60, label: '1m', key: 'player.forward60' },
  { seconds: 30, label: '30', key: 'player.forward30' },
  { seconds: 10, label: '10', key: 'player.forward10' },
] as const;
const BACK_KEYS = { 60: 'player.back60', 30: 'player.back30', 10: 'player.back10' } as const;

/**
 * Large play/pause in the middle of the picture, with −1 m, −30 s and −10 s before it and +10 s, +30 s
 * and +1 m after it, all in one row. The skips stay live during a seek: more taps collect into the next one.
 */
export function CentreControls({
  paused,
  onTogglePlay,
  onSkip,
}: {
  paused: boolean;
  onTogglePlay: () => void;
  /** Seconds, negative to go back. Quick taps are collected into one seek by the parent. */
  onSkip: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  const skip = (seconds: number, label: string, forward: boolean) => (
    <Button
      key={`${forward ? '+' : '-'}${seconds}`}
      isIconOnly
      variant="ghost"
      className="pointer-events-auto transition-transform duration-100 ease-out data-[pressed=true]:scale-80! active:scale-80! size-11 min-w-0 shrink-0 rounded-full bg-black/45 text-white backdrop-blur-sm sm:size-14 [&_svg]:size-9 sm:[&_svg]:size-11"
      aria-label={t(
        forward ? SKIPS.find((s) => s.seconds === seconds)!.key : BACK_KEYS[seconds as 10],
      )}
      onPress={() => onSkip(forward ? seconds : -seconds)}
    >
      <SeekGlyph forward={forward} label={label} />
    </Button>
  );
  return (
    <div className="pointer-events-none flex items-center justify-center gap-1 sm:gap-3">
      {[...SKIPS].map((s) => skip(s.seconds, s.label, false))}
      <Button
        isIconOnly
        variant="primary"
        className="pointer-events-auto transition-transform duration-100 ease-out data-[pressed=true]:scale-90! active:scale-90! mx-1 size-16 shrink-0 rounded-full sm:mx-2 sm:size-20 [&_svg]:size-8 sm:[&_svg]:size-10"
        aria-label={paused ? t('player.play') : t('player.pause')}
        onPress={onTogglePlay}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </Button>
      {[...SKIPS].reverse().map((s) => skip(s.seconds, s.label, true))}
    </div>
  );
}
