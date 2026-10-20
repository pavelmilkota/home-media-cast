import { Button, Chip, ProgressBar } from '@heroui/react';
import type { TitleSummary } from '@home-media-cast/shared';
import { useTranslation } from 'react-i18next';

/** A poster and a name. Posters are loaded by the browser straight from the metadata CDN. */
export function TitleCard({
  title,
  note,
  progress,
  onOpen,
}: {
  title: TitleSummary;
  /** A line under the name, e.g. "S1E2 · Cat". */
  note?: string;
  /** 0..1, drawn as a bar under the poster. */
  progress?: number;
  onOpen: (t: TitleSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      className="h-full w-full flex-col items-stretch justify-start gap-1 rounded-2xl p-2 text-left whitespace-normal wrap-anywhere"
      onPress={() => onOpen(title)}
    >
      <span className="relative block aspect-2/3 overflow-hidden rounded-[16px] bg-default shadow-md">
        {title.poster ? (
          <img
            src={title.poster}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="block size-full object-cover"
          />
        ) : (
          <span
            className="grid size-full place-items-center text-4xl text-muted"
            aria-hidden="true"
          >
            {title.name.slice(0, 1)}
          </span>
        )}
        {progress !== undefined && progress > 0 && progress < 1 && (
          <ProgressBar
            aria-label={t('common.progress')}
            aria-hidden="true"
            size="sm"
            value={progress * 100}
            className="absolute inset-x-0 bottom-0"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        )}
      </span>
      <strong className="mt-1 line-clamp-2 leading-tight">{title.name}</strong>
      <span className="flex">
        <Chip size="sm" variant="soft" color={title.type === 'movie' ? 'accent' : 'default'}>
          {[title.type === 'movie' ? t('common.movie') : t('common.series'), title.year]
            .filter(Boolean)
            .join(' · ')}
        </Chip>
      </span>
      {note && <span className="text-sm text-muted">{note}</span>}
    </Button>
  );
}
