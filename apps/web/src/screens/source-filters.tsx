import { Button } from '@heroui/react';
import type { StreamOption } from '@home-media-cast/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export type FilterKey = 'audio' | 'subtitles' | 'resolution' | 'quality';
export type Filters = Record<FilterKey, string[]>;

export const NO_FILTERS: Filters = { audio: [], subtitles: [], resolution: [], quality: [] };

const FIELDS: Record<FilterKey, (o: StreamOption) => string[]> = {
  audio: (o) => o.languages ?? [],
  subtitles: (o) => o.subtitles ?? [],
  resolution: (o) => (o.resolution ? [o.resolution] : []),
  quality: (o) => (o.quality ? [o.quality] : []),
};

const KEYS = Object.keys(FIELDS) as FilterKey[];

/** Resolutions sort high to low ("2160p" before "720p"); the rest alphabetically. */
const compare = (key: FilterKey) => (a: string, b: string) =>
  key === 'resolution' ? parseInt(b, 10) - parseInt(a, 10) : a.localeCompare(b);

/** The values each group offers, from the options on screen. */
export function filterChoices(options: StreamOption[]): Filters {
  const choices = { ...NO_FILTERS };
  for (const key of KEYS) {
    const all = new Set(options.flatMap(FIELDS[key]));
    choices[key] = [...all].sort(compare(key));
  }
  return choices;
}

/** A release passes when, in every group with a choice, it has at least one chosen value. */
export function applyFilters(options: StreamOption[], filters: Filters): StreamOption[] {
  return options.filter((o) =>
    KEYS.every((key) => {
      const chosen = filters[key];
      return chosen.length === 0 || FIELDS[key](o).some((v) => chosen.includes(v));
    }),
  );
}

export const hasFilters = (f: Filters) => KEYS.some((k) => f[k].length > 0);

/** Chips per group; picking several values of one group shows releases with any of them. */
export function SourceFilters({
  choices,
  filters,
  onChange,
}: {
  choices: Filters;
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // A group with one value cannot narrow anything, unless that value is already chosen.
  const groups = KEYS.filter((k) => choices[k].length > 1 || filters[k].length > 0);
  if (groups.length === 0) return null;
  const toggle = (key: FilterKey, value: string) =>
    onChange({
      ...filters,
      [key]: filters[key].includes(value)
        ? filters[key].filter((v) => v !== value)
        : [...filters[key], value],
    });
  const active = KEYS.reduce((n, k) => n + filters[k].length, 0);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-controls="source-filters"
          onPress={() => setOpen(!open)}
        >
          {t('sources.filters.title')}
          {active > 0 ? ` (${active})` : ''} {open ? '▴' : '▾'}
        </Button>
        {active > 0 && (
          <Button variant="ghost" onPress={() => onChange(NO_FILTERS)}>
            {t('sources.filters.clear')}
          </Button>
        )}
      </div>
      {open && (
        <div id="source-filters" className="grid gap-2">
          {groups.map((key) => (
            <div
              key={key}
              role="group"
              aria-label={t(`sources.filters.${key}`)}
              className="grid gap-1"
            >
              <span className="text-sm text-muted">{t(`sources.filters.${key}`)}</span>
              <div className="flex flex-wrap gap-1.5">
                {choices[key].map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={filters[key].includes(value) ? 'primary' : 'secondary'}
                    aria-pressed={filters[key].includes(value)}
                    onPress={() => toggle(key, value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
