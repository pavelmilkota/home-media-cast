import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DeviceInfo } from '@home-media-cast/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { devices } from '../db/schema.js';
import { hashToken, newToken } from './tokens.js';

export interface AuthenticatedDevice {
  id: string;
  name: string;
}

const TOUCH_INTERVAL_MS = 60_000;

@Injectable()
export class DeviceService {
  constructor(private readonly db: DbService) {}

  create(name: string, now = Date.now()): { deviceId: string; token: string } {
    const token = newToken();
    const deviceId = randomUUID();
    this.db.orm
      .insert(devices)
      .values({ id: deviceId, name, tokenHash: hashToken(token), createdAt: now })
      .run();
    return { deviceId, token };
  }

  /** Returns the device for a valid, non-revoked token, else undefined. */
  authenticate(token: string, now = Date.now()): AuthenticatedDevice | undefined {
    const row = this.db.orm
      .select()
      .from(devices)
      .where(and(eq(devices.tokenHash, hashToken(token)), isNull(devices.revokedAt)))
      .get();
    if (!row) return undefined;
    if (!row.lastSeenAt || now - row.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.db.orm.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id)).run();
    }
    return { id: row.id, name: row.name };
  }

  list(currentId: string): DeviceInfo[] {
    return this.db.orm
      .select()
      .from(devices)
      .where(isNull(devices.revokedAt))
      .all()
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        current: d.id === currentId,
      }));
  }

  /** True if a device was revoked now; false if it did not exist or was already revoked. */
  revoke(id: string, now = Date.now()): boolean {
    const result = this.db.orm
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .run();
    return result.changes > 0;
  }
}
