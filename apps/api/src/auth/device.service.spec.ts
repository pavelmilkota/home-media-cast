import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { DbService } from '../db/db.service.js';
import { devices } from '../db/schema.js';
import { DeviceService, GUEST_CAP, GUEST_IDLE_MS } from './device.service.js';

const setup = (guestEnabled = true) => {
  const db = new DbService(':memory:');
  return { db, svc: new DeviceService(db, { guestEnabled }) };
};

describe('devices.kind migration', () => {
  it('reads devices that existed before it as paired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmc-db-'));
    const path = join(dir, 'app.db');
    new DbService(path).onModuleDestroy();
    // An install from before 0009: no `kind` column and no journal row for it.
    const raw = new Database(path);
    raw.exec('ALTER TABLE devices DROP COLUMN kind');
    raw
      .prepare(
        'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)',
      )
      .run();
    raw
      .prepare(
        "INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d1', 'Old', 'h', 1)",
      )
      .run();
    raw.close();

    const upgraded = new DbService(path);
    expect(upgraded.orm.select().from(devices).all()).toMatchObject([{ id: 'd1', kind: 'paired' }]);
    upgraded.onModuleDestroy();
  });
});

describe('DeviceService guests', () => {
  it('creates a guest that authenticates as a guest', () => {
    const { svc } = setup();
    const { token, deviceId } = svc.createGuest('Phone', 1000);
    expect(svc.authenticate(token, 1000)).toEqual({ id: deviceId, name: 'Phone', kind: 'guest' });
    expect(svc.create('TV phone').token).not.toBe(token);
  });

  it('reports the kind in the device list', () => {
    const { svc } = setup();
    const guest = svc.createGuest('G');
    const paired = svc.create('P');
    const list = svc.list(guest.deviceId);
    expect(list.find((d) => d.id === guest.deviceId)).toMatchObject({ kind: 'guest' });
    expect(list.find((d) => d.id === paired.deviceId)).toMatchObject({ kind: 'paired' });
  });

  it('deletes guests unseen for 30 days when the next one registers, keeps paired devices', () => {
    const { svc, db } = setup();
    const old = svc.createGuest('Old', 1000);
    const paired = svc.create('Paired', 1000);
    svc.createGuest('New', 1000 + GUEST_IDLE_MS + 1);
    const ids = db.orm
      .select()
      .from(devices)
      .all()
      .map((d) => d.id);
    expect(ids).not.toContain(old.deviceId);
    expect(ids).toContain(paired.deviceId);
  });

  it('keeps a guest that was seen recently', () => {
    const { svc, db } = setup();
    const a = svc.createGuest('A', 1000);
    svc.authenticate(a.token, 1000 + GUEST_IDLE_MS - 10); // touches lastSeenAt
    svc.createGuest('B', 1000 + GUEST_IDLE_MS + 1);
    expect(db.orm.select().from(devices).all()).toHaveLength(2);
  });

  it('past the cap revokes and deletes the least recently seen, and tells the listeners', () => {
    const { svc, db } = setup();
    const revoked = vi.fn();
    svc.onRevoked(revoked);
    const first = svc.createGuest('first', 1000);
    for (let i = 1; i < GUEST_CAP; i++) svc.createGuest(`g${i}`, 1000 + i);
    expect(db.orm.select().from(devices).all()).toHaveLength(GUEST_CAP);
    svc.createGuest('over', 5000);
    const rows = db.orm.select().from(devices).all();
    expect(rows).toHaveLength(GUEST_CAP);
    expect(rows.map((r) => r.id)).not.toContain(first.deviceId);
    expect(revoked).toHaveBeenCalledWith(first.deviceId);
    expect(svc.authenticate(first.token)).toBeUndefined();
  });

  it('refuses guest tokens when guest access is off, and accepts them again when it is on', () => {
    const { db, svc } = setup();
    const { token } = svc.createGuest('Phone');
    const off = new DeviceService(db, { guestEnabled: false });
    expect(off.authenticate(token)).toBeUndefined();
    expect(off.create('Paired').token).toBeTruthy();
    expect(svc.authenticate(token)?.kind).toBe('guest');
  });

  it('promotes in place: same id, new token, old token dead, listeners told', () => {
    const { svc } = setup();
    const promoted = vi.fn();
    svc.onPromoted(promoted);
    const guest = svc.createGuest('Phone');
    const result = svc.promote(guest.deviceId, 'My phone')!;
    expect(result.deviceId).toBe(guest.deviceId);
    expect(result.token).not.toBe(guest.token);
    expect(svc.authenticate(guest.token)).toBeUndefined();
    expect(svc.authenticate(result.token)).toEqual({
      id: guest.deviceId,
      name: 'My phone',
      kind: 'paired',
    });
    expect(promoted).toHaveBeenCalledWith(guest.deviceId);
  });

  it('does not promote a paired or unknown device', () => {
    const { svc } = setup();
    const paired = svc.create('P');
    expect(svc.promote(paired.deviceId, 'x')).toBeUndefined();
    expect(svc.promote('nope', 'x')).toBeUndefined();
  });
});
