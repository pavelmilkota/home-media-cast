import { Toast } from '@heroui/react';
import type { PlayedItem } from '@home-media-cast/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { LiveProvider } from '../state/live.js';
import { FakeBackend } from '../testing/fake-backend.js';
import { renderWithClient } from '../testing/render.js';
import { PlaybackHistory } from './PlaybackHistory.js';

const item = (id: string, extra: Partial<PlayedItem> = {}): PlayedItem => ({
  id,
  type: 'movie',
  titleId: id.split(':')[0]!,
  name: `Name ${id}`,
  releaseTitle: `Release.${id}.mkv`,
  playedAt: Date.now() - 3 * 3_600_000,
  ...extra,
});

let backend: FakeBackend;
beforeEach(() => {
  auth.set('TOKEN123');
  backend = new FakeBackend().install();
});
afterEach(() => {
  vi.unstubAllGlobals();
  auth.clear();
});

const renderWidget = () =>
  renderWithClient(
    <LiveProvider token="TOKEN123">
      <Toast.Provider placement="top" />
      <PlaybackHistory startTimeoutMs={50} />
    </LiveProvider>,
  );

describe('PlaybackHistory', () => {
  it('is hidden while nothing was played', async () => {
    renderWidget();
    await waitFor(() => expect(backend.callsTo('GET /playback/history')).not.toHaveLength(0));
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
  });

  it('lists the entries with episode label, quality, release and age', async () => {
    backend.on('GET /playback/history', {
      status: 200,
      body: {
        items: [
          item('tt1:1:2', {
            type: 'series',
            name: 'Some Show',
            label: 'S1E2 · Cat',
            resolution: '1080p',
            quality: 'WEB-DL',
          }),
          item('tt2'),
        ],
      },
    });
    renderWidget();
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText('Some Show')).toBeInTheDocument();
    expect(screen.getByText('S1E2 · Cat')).toBeInTheDocument();
    expect(screen.getByText('1080p')).toBeInTheDocument();
    expect(screen.getByText('WEB-DL')).toBeInTheDocument();
    expect(screen.getByText('Release.tt1:1:2.mkv')).toBeInTheDocument();
    expect(screen.getAllByText('3 h ago')).toHaveLength(2);
    expect(screen.getByText('Name tt2')).toBeInTheDocument();
  });

  it('plays an entry again and closes', async () => {
    backend.on('GET /playback/history', { status: 200, body: { items: [item('tt1:1:2')] } });
    backend.on('POST /playback/history/tt1%3A1%3A2/play', { status: 202, body: {} });
    renderWidget();
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    await userEvent.click(await screen.findByRole('button', { name: /Play again: Name tt1:1:2/ }));
    await waitFor(() =>
      expect(backend.callsTo('POST /playback/history/tt1%3A1%3A2/play')).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByText('Recently played')).not.toBeInTheDocument());
  });

  it('shows an error toast on failure and keeps the entry', async () => {
    backend.on('GET /playback/history', { status: 200, body: { items: [item('tt1')] } });
    backend.on('POST /playback/history/tt1/play', {
      status: 404,
      body: { error: 'no_matching_source', message: 'No playable source from the same release' },
    });
    renderWidget();
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    await userEvent.click(await screen.findByRole('button', { name: /Play again: Name tt1/ }));
    await waitFor(() => expect(backend.callsTo('POST /playback/history/tt1/play')).toHaveLength(1));
    expect(await screen.findByText('No playable source from the same release')).toBeInTheDocument();
    expect(screen.getByText('Name tt1')).toBeInTheDocument();
  });
});
