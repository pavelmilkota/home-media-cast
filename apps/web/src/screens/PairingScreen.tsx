import { screen } from './ui.js';
import { Button, Card, Input, Label, TextField } from '@heroui/react';
import type { PairingCompleteResponse } from '@home-media-cast/shared';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { auth } from '../api/auth.js';
import { api } from '../api/client.js';
import { guessDeviceName } from '../format.js';

export function PairingScreen() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState(guessDeviceName);
  const start = useMutation({
    mutationFn: () => api('/pairing/start', { method: 'POST', auth: false }),
  });
  const complete = useMutation({
    mutationFn: () =>
      api<PairingCompleteResponse>('/pairing/complete', {
        method: 'POST',
        auth: false,
        body: { code, deviceName: name.trim() },
      }),
    onSuccess: (res) => auth.set(res.token),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    complete.mutate();
  };
  const ready = /^\d{6}$/.test(code) && name.trim().length > 0;

  return (
    <main className={screen}>
      <h1 className="text-2xl font-semibold">Home Media Cast</h1>
      <p className="text-muted">{t('pairing.intro')}</p>

      <Card>
        <Card.Title>{t('pairing.step1')}</Card.Title>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onPress={() => start.mutate()}
          isDisabled={start.isPending}
        >
          {start.isSuccess ? t('pairing.showNewCode') : t('pairing.showCode')}
        </Button>
        {start.isSuccess && <p className="text-success">{t('pairing.lookAtTv')}</p>}
        {start.isError && (
          <p role="alert" className="text-danger">
            {start.error.message}
          </p>
        )}
      </Card>

      <form onSubmit={submit}>
        <Card>
          <Card.Title>{t('pairing.step2')}</Card.Title>
          <TextField
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, ''))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          >
            <Label>{t('pairing.code')}</Label>
            <Input placeholder="123456" />
          </TextField>
          <TextField value={name} onChange={setName} maxLength={60}>
            <Label>{t('pairing.deviceName')}</Label>
            <Input />
          </TextField>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            isDisabled={!ready || complete.isPending}
          >
            {t('pairing.pair')}
          </Button>
          {complete.isError && (
            <p role="alert" className="text-danger">
              {complete.error.message}
            </p>
          )}
        </Card>
      </form>
    </main>
  );
}
