import { Logger as NestLogger } from '@nestjs/common';
import type { Logger } from 'yt-cast-receiver';

/** Routes the receiver's log lines through Nest's logger; the level is Nest's to filter. */
export class ReceiverLogger implements Logger {
  constructor(private readonly nest = new NestLogger('YouTubeCast')) {}
  error(...msg: unknown[]): void {
    this.nest.error(format(msg));
  }
  warn(...msg: unknown[]): void {
    this.nest.warn(format(msg));
  }
  info(...msg: unknown[]): void {
    this.nest.log(format(msg));
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
