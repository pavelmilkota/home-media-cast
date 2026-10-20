import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { FakeBackend } from '../testing/fake-backend.js';
import { renderWithClient } from '../testing/render.js';
import { SourceCacheCard } from './SourceCacheCard.js';

let backend: FakeBackend;
beforeEach(() => {
  auth.set('TOKEN123');
  backend = new FakeBackend().install();
});
afterEach(() => {
  vi.unstubAllGlobals();
  auth.clear();
});

describe('SourceCacheCard', () => {
  it('shows how many lists are cached and how old the oldest is', async () => {
    backend.on('GET /streams/cache', {
      status: 200,
      body: { entries: 3, oldestFetchedAt: Date.now() - 2 * 24 * 3_600_000 },
    });
    renderWithClient(<SourceCacheCard />);
    expect(await screen.findByText('3 lists · oldest 2 d ago')).toBeInTheDocument();
  });

  it('says Empty when nothing is cached', async () => {
    backend.on('GET /streams/cache', { status: 200, body: { entries: 0 } });
    renderWithClient(<SourceCacheCard />);
    expect(await screen.findByText('Empty')).toBeInTheDocument();
  });

  it('clears the cache without a confirm step, reports the count and reloads the stats', async () => {
    let entries = 2;
    backend.on('GET /streams/cache', () => ({
      status: 200,
      body: entries ? { entries, oldestFetchedAt: Date.now() - 60_000 } : { entries },
    }));
    backend.on('DELETE /streams/cache', () => {
      const cleared = entries;
      entries = 0;
      return { status: 200, body: { cleared } };
    });
    renderWithClient(<SourceCacheCard />);
    await screen.findByText('2 lists · oldest 1 min ago');
    await userEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    expect(await screen.findByText('Cleared 2 lists')).toBeInTheDocument();
    expect(await screen.findByText('Empty')).toBeInTheDocument();
    expect(backend.callsTo('DELETE /streams/cache')).toHaveLength(1);
  });

  it('shows the error when clearing fails', async () => {
    backend.on('GET /streams/cache', { status: 200, body: { entries: 1, oldestFetchedAt: 1 } });
    backend.on('DELETE /streams/cache', { status: 500, body: { message: 'Database is locked' } });
    renderWithClient(<SourceCacheCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Clear cache' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is locked');
    await waitFor(() => expect(backend.callsTo('DELETE /streams/cache')).toHaveLength(1));
  });
});
