import { ConsoleLogger } from '@nestjs/common';
import { format } from 'node:util';
import type { AppLogEntry } from '@home-media-cast/shared';
import { redactLine } from '../redact.js';

const CAPACITY = 1000;

/**
 * Nest's console logger, plus a bounded memory of the warnings and errors it was asked to write
 * (what the Logs page shows). Lines are redacted before they are stored. Request lines use
 * `log` level, so the per-second relay noise never gets in.
 */
export class AppLogBuffer extends ConsoleLogger {
  private static current: AppLogBuffer | undefined;

  /** The instance `main.ts` installs, so a provider can read what it recorded. */
  static shared(): AppLogBuffer {
    return (AppLogBuffer.current ??= new AppLogBuffer());
  }

  private readonly items: AppLogEntry[] = [];

  constructor(private readonly capacity = CAPACITY) {
    super();
  }

  /** Oldest first. */
  entries(): AppLogEntry[] {
    return [...this.items];
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    super.warn(message, ...rest);
    this.record('warn', message, rest);
  }

  override error(message: unknown, ...rest: unknown[]): void {
    super.error(message, ...rest);
    this.record('error', message, rest);
  }

  override fatal(message: unknown, ...rest: unknown[]): void {
    super.fatal(message, ...rest);
    this.record('error', message, rest);
  }

  private record(level: AppLogEntry['level'], message: unknown, rest: unknown[]): void {
    // Nest appends the context last; an error may also carry a stack before it.
    const last = rest.at(-1);
    const context = typeof last === 'string' && !isStack(last) ? last : this.context;
    const extra = (context && last === context ? rest.slice(0, -1) : rest).filter(
      (p): p is string => typeof p === 'string',
    );
    const text = [typeof message === 'string' ? message : format('%O', message), ...extra].join(
      '\n',
    );
    this.items.push({
      time: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      message: redactLine(text),
    });
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
}

const isStack = (s: string): boolean => s.includes('\n    at ');
