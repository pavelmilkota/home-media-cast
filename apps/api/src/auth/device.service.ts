import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DeviceInfo } from '@home-media-cast/shared';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service.js';
import { devices } from '../db/schema.js';
import { hashToken, newToken } from './tokens.js';

export type DeviceKind = 'paired' | 'guest';

export interface AuthenticatedDevice {
  id: string;
  name: string;
  kind: DeviceKind;
}

const TOUCH_INTERVAL_MS = 60_000;
/** A guest nobody has seen for this long is deleted when the next guest registers. */
export const GUEST_IDLE_MS = 30 * 24 * 3600_000;
/** Most guest rows kept; past it the least recently seen are revoked and deleted. */
export const GUEST_CAP = 200;

type RevokedListener = (deviceId: string) => void;

export interface DeviceServiceOptions {
  /** `GUEST_PLAYBACK_ENABLED`: when false, guest tokens stop working and none can register. */
  guestEnabled: boolean;
}

@Injectable()
export class DeviceService {
  private readonly revokedListeners: RevokedListener[] = [];
  private readonly promotedListeners: RevokedListener[] = [];

  constructor(
    private readonly db: DbService,
    private readonly options: DeviceServiceOptions = { guestEnabled: true },
  ) {}

  get guestEnabled(): boolean {
    return this.options.guestEnabled;
  }

  /** Called after a guest becomes a paired device (same id), so its sessions can start saving. */
  onPromoted(listener: RevokedListener): void {
    this.promotedListeners.push(listener);
  }

  /** Called after a device is revoked, so what it was using (a stream) can be cut off at once. */
  onRevoked(listener: RevokedListener): void {
    this.revokedListeners.push(listener);
  }

  create(name: string, now = Date.now()): { deviceId: string; token: string } {
    const token = newToken();
    const deviceId = randomUUID();
    this.db.orm
      .insert(devices)
      .values({ id: deviceId, name, tokenHash: hashToken(token), createdAt: now })
      .run();
    return { deviceId, token };
  }

  /**
   * Registers an unpaired device. Old guests are pruned first, and past the cap the least
   * recently seen ones are revoked, so what they were streaming stops.
   */
  createGuest(name: string, now = Date.now()): { deviceId: string; token: string } {
    const guests = eq(devices.kind, 'guest');
    this.db.orm
      .delete(devices)
      .where(
        and(
          guests,
          or(
            lt(devices.lastSeenAt, now - GUEST_IDLE_MS),
            and(isNull(devices.lastSeenAt), lt(devices.createdAt, now - GUEST_IDLE_MS)),
          ),
        ),
      )
      .run();
    const count =
      this.db.orm
        .select({ n: sql<number>`count(*)` })
        .from(devices)
        .where(guests)
        .get()?.n ?? 0;
    if (count >= GUEST_CAP) {
      const oldest = this.db.orm
        .select({ id: devices.id })
        .from(devices)
        .where(guests)
        .orderBy(asc(sql`coalesce(${devices.lastSeenAt}, ${devices.createdAt})`))
        .limit(count - GUEST_CAP + 1)
        .all();
      for (const { id } of oldest) {
        this.revoke(id, now);
        this.db.orm.delete(devices).where(eq(devices.id, id)).run();
      }
    }
    const token = newToken();
    const deviceId = randomUUID();
    this.db.orm
      .insert(devices)
      .values({
        id: deviceId,
        name,
        tokenHash: hashToken(token),
        createdAt: now,
        lastSeenAt: now,
        kind: 'guest',
      })
      .run();
    return { deviceId, token };
  }

  /**
   * Turns a guest into a paired device in place: same id, so its session stays its own, and a
   * new token, so the guest token stops working. Undefined if it is not a live guest.
   */
  promote(
    id: string,
    name: string,
    now = Date.now(),
  ): { deviceId: string; token: string } | undefined {
    const token = newToken();
    const result = this.db.orm
      .update(devices)
      .set({ kind: 'paired', name, tokenHash: hashToken(token), lastSeenAt: now })
      .where(and(eq(devices.id, id), eq(devices.kind, 'guest'), isNull(devices.revokedAt)))
      .run();
    if (result.changes === 0) return undefined;
    for (const listener of this.promotedListeners) listener(id);
    return { deviceId: id, token };
  }

  /** Returns the device for a valid, non-revoked token, else undefined. */
  authenticate(token: string, now = Date.now()): AuthenticatedDevice | undefined {
    const row = this.db.orm
      .select()
      .from(devices)
      .where(and(eq(devices.tokenHash, hashToken(token)), isNull(devices.revokedAt)))
      .get();
    if (!row) return undefined;
    if (row.kind === 'guest' && !this.options.guestEnabled) return undefined;
    if (!row.lastSeenAt || now - row.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.db.orm.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id)).run();
    }
    return { id: row.id, name: row.name, kind: row.kind };
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
        kind: d.kind,
      }));
  }

  /** The name a device was paired under. */
  nameOf(id: string): string | undefined {
    return this.db.orm.select().from(devices).where(eq(devices.id, id)).get()?.name;
  }

  /** True if a device was revoked now; false if it did not exist or was already revoked. */
  revoke(id: string, now = Date.now()): boolean {
    const result = this.db.orm
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .run();
    if (result.changes === 0) return false;
    for (const listener of this.revokedListeners) listener(id);
    return true;
  }
}
