import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { LocaleProvider } from '../i18n/LocaleProvider.js';
import { createAppRouter } from '../router.js';

export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <LocaleProvider>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </LocaleProvider>,
  );
}

/** Mounts the real route tree on an in-memory history, like the app at `url`. */
export async function renderApp({ url = '/' }: { url?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
  const result = render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LocaleProvider>,
  );
  await act(() => router.load());
  return { ...result, router };
}
