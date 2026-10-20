import type { NextFunction, Request, Response } from 'express';
import { redactUrl } from './redact.js';

/**
 * One line per request: method, redacted URL, status and duration. Headers and bodies are
 * never logged, so tokens, pairing codes and pasted links cannot end up in the log.
 */
export function requestLogger(log: (line: string) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();
    res.on('finish', () => {
      log(
        `${req.method} ${redactUrl(req.originalUrl)} ${res.statusCode} ${Date.now() - started}ms`,
      );
    });
    next();
  };
}
