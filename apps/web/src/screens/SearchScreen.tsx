import { grid, screen } from './ui.js';
import { Button, Card, Label, SearchField } from '@heroui/react';
import type { SearchResponse, TitleSummary } from '@home-media-cast/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useDebounced } from '../state/use-debounced.js';
import { BrowseList } from './BrowseList.js';
import { LinkAction, linkOf } from './LinkAction.js';
import { TitleCard } from './TitleCard.js';

/** Finds an IMDb id in `tt0111161` or in a pasted IMDb link; nothing else counts. */
export function imdbIdOf(text: string): string | undefined {
  return /tt\d{7,10}/.exec(text.trim())?.[0];
}

/** How long typing must pause before the search runs. */
const SEARCH_DEBOUNCE_MS = 300;

export function SearchScreen({
  query,
  onQuery,
  onOpen,
  onStarted,
  startTimeoutMs,
  autoFocus,
}: {
  /** The committed search, kept in the URL so going back from a title shows the results. */
  query: string;
  /** `replace`: the query follows live typing, so it must not add a history entry per pause. */
  onQuery: (q: string, replace?: boolean) => void;
  onOpen: (t: { id: string; type: TitleSummary['type'] }) => void;
  /** Called once a pasted link is playing on the TV. */
  onStarted: () => void;
  startTimeoutMs?: number;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(query);
  // Back/forward changes the committed query; follow it without touching what is being typed.
  // Our own live updates come back through `query` too and must not overwrite newer typing.
  const [seen, setSeen] = useState(query);
  const [pushed, setPushed] = useState(query);
  if (seen !== query) {
    setSeen(query);
    if (query !== pushed) setText(query);
  }

  const pasted = imdbIdOf(text);
  const link = linkOf(text);
  // A pasted link or IMDb id is not a title search.
  const typed = pasted || link ? '' : text.trim();
  const debounced = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  // Enter searches at once instead of waiting out the pause.
  const [forced, setForced] = useState<string>();
  const active = forced !== undefined && forced === typed ? forced : debounced;

  const latestQuery = useRef(query);
  useEffect(() => {
    latestQuery.current = query;
  });
  // Keep the address in step with the search shown, so Back from a title finds it again. Runs
  // only when the searched text changes, never when the address does (that is Back/forward).
  useEffect(() => {
    const q = active.length >= 2 ? active : '';
    if (q === latestQuery.current) return;
    setPushed(q);
    onQuery(q, true);
    // `onQuery` is deliberately not a trigger.
  }, [active]);

  const results = useQuery({
    queryKey: ['search', active],
    queryFn: () => api<SearchResponse>(`/catalog/search?q=${encodeURIComponent(active)}`),
    enabled: active.length >= 2,
    staleTime: 10 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (q.length >= 2 && !link) {
      setForced(q);
      setPushed(q);
      onQuery(q, false);
    }
  };
  return (
    <main className={screen}>
      <form onSubmit={submit} role="search">
        <Card>
          <Card.Title>{t('search.title')}</Card.Title>
          <SearchField value={text} onChange={setText} autoFocus={autoFocus}>
            <Label>{t('search.label')}</Label>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input
                enterKeyHint="search"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('search.placeholder')}
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            isDisabled={text.trim().length < 2 || link !== undefined}
          >
            {t('search.submit')}
          </Button>
          {pasted && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onPress={() => onOpen({ id: pasted, type: 'movie' })}>
                {t('search.openAsMovie', { id: pasted })}
              </Button>
              <Button variant="secondary" onPress={() => onOpen({ id: pasted, type: 'series' })}>
                {t('search.openAsSeries', { id: pasted })}
              </Button>
            </div>
          )}
        </Card>
      </form>

      {link && (
        <LinkAction
          url={link}
          onStarted={() => {
            setText('');
            onStarted();
          }}
          {...(startTimeoutMs !== undefined ? { startTimeoutMs } : {})}
        />
      )}

      {!link && !pasted && active.length < 2 && <BrowseList onOpen={onOpen} />}

      {active.length >= 2 && results.isFetching && (
        <p className="text-muted" role="status">
          {t('search.searching')}
        </p>
      )}
      {results.isError && (
        <p role="alert" className="text-danger">
          {results.error.message}
        </p>
      )}
      {active.length >= 2 &&
        results.data &&
        !results.isFetching &&
        results.data.results.length === 0 && (
          <p className="text-muted">{t('search.nothingFound', { query: active })}</p>
        )}
      {active.length >= 2 && results.data && results.data.results.length > 0 && (
        <ul className={grid} aria-label={t('search.results')}>
          {results.data.results.map((t) => (
            <li key={`${t.type}-${t.id}`}>
              <TitleCard title={t} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
