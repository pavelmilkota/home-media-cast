import { Logger as NestLogger } from '@nestjs/common';
import type { Logger } from 'yt-cast-receiver';

type Level = 'error' | 'warn' | 'log';

/** A line repeated within this long is counted, not printed again. */
const REPEAT_WINDOW_MS = 60_000;

/**
 * Routes the receiver's log lines through Nest's logger; the level is Nest's to filter. The same
 * line in a burst is printed once and then counted: a lounge disconnect once wrote about six
 * million identical errors in a few seconds, filling the container log.
 */
export class ReceiverLogger implements Logger {
  private last: { level: Level; text: string; at: number; repeats: number } | undefined;

  constructor(
    private readonly nest = new NestLogger('YouTubeCast'),
    private readonly now: () => number = Date.now,
  ) {}
  error(...msg: unknown[]): void {
    this.emit('error', format(msg));
  }
  warn(...msg: unknown[]): void {
    this.emit('warn', format(msg));
  }
  info(...msg: unknown[]): void {
    this.emit('log', format(msg));
  }

  private emit(level: Level, text: string): void {
    const now = this.now();
    const last = this.last;
    if (last && last.level === level && last.text === text && now - last.at < REPEAT_WINDOW_MS) {
      last.repeats++;
      return;
    }
    this.flush();
    this.last = { level, text, at: now, repeats: 0 };
    this.nest[level](text);
  }

  /** Says how often the last line came again, if it did. */
  private flush(): void {
    const last = this.last;
    if (last && last.repeats > 0) {
      this.nest[last.level](`(the line above repeated ${last.repeats} more times)`);
    }
  }
  debug(): void {
    // Dropped on purpose: the library's debug lines carry lounge tokens and session ids,
    // and secrets never go to logs (AGENTS.md).
  }
  setLevel(): void {
    // Nest decides what is printed.
  }
}

const format = (msg: unknown[]): string =>
  msg
    .map((m) => (m instanceof Error ? m.message : typeof m === 'string' ? m : JSON.stringify(m)))
    .join(' ');
