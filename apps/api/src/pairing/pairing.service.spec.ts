import { describe, expect, it } from 'vitest';
import { DeviceService } from '../auth/device.service.js';
import { DbService } from '../db/db.service.js';
import type { KodiService } from '../kodi/kodi.service.js';
import { CODE_TTL_MS, PairingService, START_COOLDOWN_MS } from './pairing.service.js';

function setup() {
  let now = 1_000_000;
  let shown = '';
  const kodi = {
    commands: {
      showNotification: (_title: string, message: string) => {
        shown = /\d{6}/.exec(message)![0];
        return Promise.resolve();
      },
    },
  } as unknown as KodiService;
  const devices = new DeviceService(new DbService(':memory:'));
  const pairing = new PairingService(kodi, devices, () => now);
  return { pairing, code: () => shown, advance: (ms: number) => (now += ms) };
}

describe('PairingService', () => {
  it('accepts the code just before it expires', async () => {
    const s = setup();
    await s.pairing.start();
    s.advance(CODE_TTL_MS);
    expect(s.pairing.complete(s.code(), 'phone').token).toBeTruthy();
  });

  it('rejects the right code once it has expired', async () => {
    const s = setup();
    await s.pairing.start();
    s.advance(CODE_TTL_MS + 1);
    expect(() => s.pairing.complete(s.code(), 'phone')).toThrow('Invalid or expired code');
  });

  it('allows a new code after the cooldown, and the new code replaces the old one', async () => {
    const s = setup();
    await s.pairing.start();
    const first = s.code();
    await expect(s.pairing.start()).rejects.toThrow(/Wait/);
    s.advance(START_COOLDOWN_MS);
    await s.pairing.start();
    if (first !== s.code()) {
      expect(() => s.pairing.complete(first, 'phone')).toThrow('Invalid or expired code');
    }
    expect(s.pairing.complete(s.code(), 'phone').deviceId).toBeTruthy();
  });
});
