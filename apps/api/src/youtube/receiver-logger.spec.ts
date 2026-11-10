import { describe, expect, it, vi } from 'vitest';
import type { Logger as NestLogger } from '@nestjs/common';
import { ReceiverLogger } from './receiver-logger.js';

describe('ReceiverLogger', () => {
  const nest = () => ({ error: vi.fn(), warn: vi.fn(), log: vi.fn(), debug: vi.fn() });

  it('never forwards debug lines, which carry lounge tokens and session ids', () => {
    const n = nest();
    const logger = new ReceiverLogger(n as unknown as NestLogger);
    (logger.debug as (...m: unknown[]) => void)('Obtained lounge token:', {
      loungeToken: 'SECRET',
    });
    expect(n.debug).not.toHaveBeenCalled();
    expect(n.log).not.toHaveBeenCalled();
  });

  it('forwards info, warn and error, joining the parts', () => {
    const n = nest();
    const logger = new ReceiverLogger(n as unknown as NestLogger);
    logger.info('a', { b: 1 });
    logger.warn('w');
    logger.error('e', new Error('boom'));
    expect(n.log).toHaveBeenCalledWith('a {"b":1}');
    expect(n.warn).toHaveBeenCalledWith('w');
    expect(n.error).toHaveBeenCalledWith('e boom');
  });

  it('prints a burst of the same line once, then how often it came again', () => {
    const n = nest();
    let clock = 0;
    const logger = new ReceiverLogger(n as unknown as NestLogger, () => clock);
    for (let i = 0; i < 1000; i++) logger.error('loungeScreenDisconnected');
    expect(n.error).toHaveBeenCalledTimes(1);
    logger.warn('something else');
    expect(n.error).toHaveBeenLastCalledWith('(the line above repeated 999 more times)');
    expect(n.warn).toHaveBeenCalledWith('something else');
    clock = 61_000;
    logger.warn('something else');
    expect(n.warn).toHaveBeenCalledTimes(2); // a minute later it is news again
  });
});
