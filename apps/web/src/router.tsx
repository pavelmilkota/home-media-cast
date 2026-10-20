import type { CatalogType } from '@home-media-cast/shared';
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
  useRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { App } from './App.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LibraryScreen } from './screens/LibraryScreen.js';
import { SearchScreen } from './screens/SearchScreen.js';
import { TitleScreen } from './screens/TitleScreen.js';

export type Sheet = 'remote' | 'settings';

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface HistoryState {
    /** One-shot intent from Home: land on Search with the input focused. */
    focus?: boolean;
    /** Set on the entry a sheet was pushed with, so closing the sheet can go Back. */
    sheetPush?: boolean;
  }
}

const isCatalogType = (t: string): t is CatalogType => t === 'movie' || t === 'series';

export function validateRootSearch(search: Record<string, unknown>): { sheet?: Sheet } {
  return search.sheet === 'remote' || search.sheet === 'settings' ? { sheet: search.sheet } : {};
}

export function validateSearchQuery(search: Record<string, unknown>): { q?: string } {
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  return q.length >= 2 ? { q } : {};
}

const rootRoute = createRootRoute({ component: App, validateSearch: validateRootSearch });

function HomeRoute() {
  const navigate = useNavigate();
  const searchFocused = () => void navigate({ to: '/search', state: { focus: true } });
  return (
    <HomeScreen
      onOpen={(t) => void navigate({ to: '/title/$type/$id', params: t })}
      onSearch={searchFocused}
      onPlayLink={searchFocused}
    />
  );
}

function LibraryRoute() {
  const navigate = useNavigate();
  return <LibraryScreen onOpen={(t) => void navigate({ to: '/title/$type/$id', params: t })} />;
}

function SearchRoute() {
  const navigate = useNavigate();
  const { q } = searchRoute.useSearch();
  const focus = useLocation({ select: (l) => l.state.focus === true });
  return (
    <SearchScreen
      query={q ?? ''}
      onQuery={(next, replace) =>
        void navigate({
          to: '/search',
          search: (prev) => ({ ...prev, q: next }),
          ...(replace ? { replace: true } : {}),
        })
      }
      onOpen={(t) => void navigate({ to: '/title/$type/$id', params: t })}
      onStarted={() => {}}
      autoFocus={focus}
    />
  );
}

function TitleRoute() {
  const { type, id } = titleRoute.useParams();
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const back = () =>
    canGoBack ? router.history.back() : void navigate({ to: '/', replace: true });
  if (!isCatalogType(type)) return null;
  return (
    <TitleScreen key={`${type}-${id}`} type={type} id={id} onBack={back} onStarted={() => {}} />
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'library',
  component: LibraryRoute,
});
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'search',
  validateSearch: validateSearchQuery,
  component: SearchRoute,
});
const titleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'title/$type/$id',
  beforeLoad: ({ params }) => {
    if (!isCatalogType(params.type) || params.id.length === 0) {
      throw redirect({ to: '/', replace: true });
    }
  },
  component: TitleRoute,
});
// Unknown paths land on Home.
const unknownRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  searchRoute,
  titleRoute,
  unknownRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, scrollRestoration: true, ...(history ? { history } : {}) });
}
