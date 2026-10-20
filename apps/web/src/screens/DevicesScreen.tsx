import { Button, Card, Chip } from '@heroui/react';
import type { DeviceInfo } from '@home-media-cast/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { auth } from '../api/auth.js';
import { api } from '../api/client.js';
import { timeAgo } from '../format.js';

export function DevicesScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceInfo[]>('/devices') });
  const revoke = useMutation({
    mutationFn: (device: DeviceInfo) =>
      api(`/devices/${device.id}`, { method: 'DELETE' }).then(() => device),
    onSuccess: (device) => {
      setConfirming(null);
      if (device.current)
        auth.clear(); // this phone just signed itself out
      else void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  return (
    <Card>
      <Card.Title>{t('devices.title')}</Card.Title>
      {devices.isPending && <p className="text-muted">{t('common.loading')}</p>}
      {devices.isError && (
        <p role="alert" className="text-danger">
          {devices.error.message}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {devices.data?.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3">
            <div>
              <strong>{d.name}</strong>{' '}
              {d.current && (
                <Chip size="sm" variant="soft">
                  {t('devices.thisDevice')}
                </Chip>
              )}
              <div className="text-muted">
                {t('devices.lastSeen', { when: timeAgo(d.lastSeenAt) })}
              </div>
            </div>
            {confirming === d.id ? (
              <span className="flex flex-wrap gap-2">
                <Button variant="danger-soft" onPress={() => revoke.mutate(d)}>
                  {t('common.confirm')}
                </Button>
                <Button variant="secondary" onPress={() => setConfirming(null)}>
                  {t('common.cancel')}
                </Button>
              </span>
            ) : (
              <Button
                variant="secondary"
                onPress={() => setConfirming(d.id)}
                aria-label={t('devices.revokeNamed', { name: d.name })}
              >
                {t('devices.revoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {revoke.isError && (
        <p role="alert" className="text-danger">
          {revoke.error.message}
        </p>
      )}
    </Card>
  );
}
