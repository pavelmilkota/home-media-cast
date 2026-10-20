import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { QueueEntry } from '@home-media-cast/shared';

export class QueueFullError extends Error {
  override readonly name = 'QueueFullError';
}

/** What the phone sees (`entry`) plus what stays in the backend. */
interface Queued {
  entry: QueueEntry;
  /** Release group of the source that was picked; the same group is looked for at play time. */
  bingeGroup?: string;
}

/**
 * The play queue, one for the household. It lives in memory: a restart empties it. Entries
 * hold no link (ADR-0005); a fresh source is resolved when the entry is played.
 */
@Injectable()
export class QueueService {
  private items: Queued[] = [];

  constructor(private readonly max = 50) {}

  list(): QueueEntry[] {
    return this.items.map((q) => q.entry);
  }

  add(entry: Omit<QueueEntry, 'id'>, bingeGroup?: string): QueueEntry {
    if (this.items.length >= this.max)
      throw new QueueFullError(`The queue holds ${this.max} items`);
    const full = { id: randomBytes(6).toString('base64url'), ...entry };
    this.items.push({ entry: full, ...(bingeGroup ? { bingeGroup } : {}) });
    return full;
  }

  /** Removes and returns the first entry. */
  shift(): Queued | undefined {
    return this.items.shift();
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((q) => q.entry.id !== id);
    return this.items.length < before;
  }

  clear(): void {
    this.items = [];
  }
}
