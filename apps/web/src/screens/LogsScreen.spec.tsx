import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../api/auth.js';
import { FakeBackend } from '../testing/fake-backend.js';
import { renderWithClient } from '../testing/render.js';
import { kodiLevel, LogsScreen, type LogTab } from './LogsScreen.js';

let backend: FakeBackend;
beforeEach(() => {
  auth.set('TOKEN123');
  backend = new FakeBackend().install();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  auth.clear();
});

const show = (tab: LogTab = 'kodi', onTab = vi.fn(), onBack = vi.fn()) => {
  renderWithClient(<LogsScreen tab={tab} onTab={onTab} onBack={onBack} />);
  return { onTab, onBack };
};

describe('kodiLevel', () => {
  it.each([
    ['2026-10-22 21:30:00.000 T:1   error <general>: x', 'error'],
    ['2026-10-22 21:30:00.000 T:1   warning <general>: x', 'warn'],
    ['2026-10-22 21:30:00.000 T:1   info <general>: x', 'info'],
    ['a continuation line', 'info'],
  ])('%s', (line, level) => expect(kodiLevel(line)).toBe(level));
});

describe('LogsScreen', () => {
  it('shows the Kodi lines and sends only the bearer header', async () => {
    show();
    expect(await screen.findByText(/Starting Kodi/)).toBeInTheDocument();
    const [call] = backend.callsTo('GET /logs/kodi');
    expect(call?.authorization).toBe('Bearer TOKEN123');
    expect(call?.query).toBe('');
    expect(backend.callsTo('GET /logs/app')).toHaveLength(0);
  });

  it('shows the app entries on the App tab', async () => {
    show('app');
    expect(
      await screen.findByText(/Relay request failed: Upstream unreachable/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\[KodiService\] Kodi call timed out/)).toBeInTheDocument();
  });

  it('reports the tab the user picks', async () => {
    const { onTab } = show('kodi');
    await userEvent.click(await screen.findByRole('tab', { name: 'App' }));
    expect(onTab).toHaveBeenCalledWith('app');
  });

  it('hides info lines when filtering to warnings and errors', async () => {
    show();
    await screen.findByText(/Starting Kodi/);
    await userEvent.click(screen.getByRole('button', { name: 'Warnings and errors' }));
    expect(screen.queryByText(/Starting Kodi/)).not.toBeInTheDocument();
    expect(screen.getByText(/read stalled/)).toBeInTheDocument();
    expect(screen.getByText(/Playback failed/)).toBeInTheDocument();
  });

  it('refetches on Refresh', async () => {
    show();
    await screen.findByText(/Starting Kodi/);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(backend.callsTo('GET /logs/kodi')).toHaveLength(2));
  });

  it('polls only while Auto-refresh is on', async () => {
    show();
    await screen.findByText(/Starting Kodi/);
    expect(backend.callsTo('GET /logs/kodi')).toHaveLength(1);
    await userEvent.click(screen.getByRole('switch', { name: 'Auto-refresh' }));
    await waitFor(() => expect(backend.callsTo('GET /logs/kodi').length).toBeGreaterThan(1), {
      timeout: 7000,
    });
  }, 10_000);

  it('explains how to enable the Kodi log when it is unavailable', async () => {
    backend.on('GET /logs/kodi', {
      status: 200,
      body: { available: false, lines: [], truncated: false },
    });
    show();
    expect(await screen.findByText(/KODI_LOG_DIR/)).toBeInTheDocument();
  });

  it('says so when there is nothing to show', async () => {
    backend.on('GET /logs/app', { status: 200, body: { entries: [] } });
    show('app');
    expect(await screen.findByText('Nothing to show.')).toBeInTheDocument();
  });

  it('shows a request error', async () => {
    backend.on('GET /logs/kodi', { status: 500, body: { message: 'boom' } });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom|500/);
  });

  it('goes back', async () => {
    const { onBack } = show();
    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalled();
  });
});
