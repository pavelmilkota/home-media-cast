/**
 * Guesses where an external player is from which bytes of the file it asked for. A web page cannot
 * read a player's position, so this is all there is: the byte offset of the read that has run
 * longest, over the file's size, times its length, minus a margin for what the player has buffered.
 * ⚠️ unverified against real players; the margin is a guess until measured (spike.md).
 */
export interface ReadTrackerOptions {
  sizeBytes: number;
  durationMs: number;
  now: () => number;
  /** Subtracted from the estimate: what a player has read ahead of what it shows. */
  marginMs?: number;
}

interface Read {
  id: number;
  startByte: number;
  /** Bytes sent so far on this read. */
  sent: number;
  openedAt: number;
  closedAt: number | undefined;
}

/** A read this close to the end of the file is a player looking for an index, not playing. */
export function nearEnd(startByte: number, sizeBytes: number): boolean {
  // Never more than a tenth of a small file, or every read of it would count as the index.
  const tail = Math.min(Math.max(2_000_000, sizeBytes * 0.01), sizeBytes * 0.1);
  return startByte >= sizeBytes - tail;
}

export class ReadTracker {
  private readonly reads = new Map<number, Read>();
  /** The read that played last, once it closed: kept so a pause still has a position. */
  private lastClosed: Read | undefined;
  private readonly marginMs: number;

  constructor(private readonly options: ReadTrackerOptions) {
    this.marginMs = options.marginMs ?? 10_000;
  }

  /** A read begins at `startByte`. Returns false, and tracks nothing, for one near the end. */
  start(id: number, startByte: number): boolean {
    if (nearEnd(startByte, this.options.sizeBytes)) return false;
    this.reads.set(id, {
      id,
      startByte,
      sent: 0,
      openedAt: this.options.now(),
      closedAt: undefined,
    });
    return true;
  }

  /** The read has sent `bytes` in total. */
  sent(id: number, bytes: number): void {
    const read = this.reads.get(id);
    if (read) read.sent = Math.max(read.sent, bytes);
  }

  end(id: number): void {
    const read = this.reads.get(id);
    if (!read) return;
    read.closedAt = this.options.now();
    this.lastClosed = read;
    this.reads.delete(id);
  }

  /**
   * The position and how long the read it comes from has run, or undefined before any read. The
   * read that has been open longest wins: a player that probes the file and then plays opens
   * several, and the playing one outlasts the rest. After a seek the old read closes, so the new
   * one wins.
   */
  estimate(): { positionMs: number; sequentialMs: number } | undefined {
    const { durationMs, sizeBytes } = this.options;
    if (durationMs <= 0 || sizeBytes <= 0) return undefined;
    let read: Read | undefined;
    for (const r of this.reads.values()) if (!read || r.openedAt < read.openedAt) read = r;
    read ??= this.lastClosed;
    if (!read) return undefined;
    const offset = Math.min(sizeBytes, read.startByte + read.sent);
    const raw = (offset / sizeBytes) * durationMs - this.marginMs;
    return {
      positionMs: Math.round(Math.max(0, Math.min(durationMs, raw))),
      sequentialMs: (read.closedAt ?? this.options.now()) - read.openedAt,
    };
  }
}
