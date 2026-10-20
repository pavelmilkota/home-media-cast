import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * Serves the built PWA from the API process (one container, one port). Unknown GET paths
 * fall back to index.html so client-side routes survive a reload; `/api/*` is never shadowed.
 * Returns false when there is no build to serve.
 */
export function serveWeb(app: INestApplication, dir: string): boolean {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return false;
  // `index: false` lets the fallback below send index.html with no-cache for "/" too.
  app.use(express.static(dir, { index: false }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return true;
}
