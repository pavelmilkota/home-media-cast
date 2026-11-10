import { Button } from '@heroui/react';
import type { PairingCompleteResponse } from '@home-media-cast/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { auth } from '../api/auth.js';
import { ApiError, api } from '../api/client.js';
import { guessDeviceName } from '../format.js';
import { PairingScreen } from './PairingScreen.js';
import { screen } from './ui.js';

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;

// One registration at a time, even if the component mounts twice (React strict mode in dev).
let inflight: Promise<PairingCompleteResponse> | undefined;
function register(): Promise<PairingCompleteResponse> {
  inflight ??= api<PairingCompleteResponse>('/guest', {
    method: 'POST',
    auth: false,
    body: { deviceName: guessDeviceName() },
  }).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/**
 * A device with no token registers itself as a guest and goes on to the app: no pairing wall.
 * Only when the server has guests switched off (`403 guest_disabled`) is pairing shown. A network
 * error or a rate limit shows a retry, which also runs by itself with a growing delay.
 */
export function GuestBootstrap() {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'error' | 'disabled'>('loading');

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    setState('loading');
    register().then(
      (res) => auth.set(res.token, 'guest'),
      (e: unknown) => {
        if (e instanceof ApiError && e.code === 'guest_disabled') return setState('disabled');
        setState('error');
        retry = setTimeout(
          () => setAttempt((n) => n + 1),
          Math.min(RETRY_MIN_MS * 2 ** attempt, RETRY_MAX_MS),
        );
      },
    );
    return () => clearTimeout(retry);
  }, [attempt]);

  if (state === 'disabled') return <PairingScreen />;
  return (
    <main className={`${screen} min-h-svh items-center justify-center text-center`}>
      <h1 className="text-2xl font-semibold">Home Media Cast</h1>
      {state === 'loading' ? (
        <p className="text-muted" role="status">
          {t('guest.starting')}
        </p>
      ) : (
        <>
          <p role="alert" className="text-danger">
            {t('guest.cannotReach')}
          </p>
          <Button variant="primary" onPress={() => setAttempt((n) => n + 1)}>
            {t('common.tryAgain')}
          </Button>
        </>
      )}
    </main>
  );
}
