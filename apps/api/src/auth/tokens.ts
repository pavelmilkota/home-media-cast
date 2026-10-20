import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, so a plain SHA-256 is enough; no password-style stretching needed. */
export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
