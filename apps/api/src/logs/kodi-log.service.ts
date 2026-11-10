import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { KodiLogResponse } from '@home-media-cast/shared';
import { redactLine } from '../redact.js';

export const MAX_KODI_LOG_LINES = 500;
const CHUNK_BYTES = 256 * 1024;
const FILE_NAME = 'kodi.log';

/** The end of Kodi's own log, read from a host directory mounted read-only. */
export class KodiLogService {
  constructor(private readonly dir: string | undefined) {}

  async tail(lines: number): Promise<KodiLogResponse> {
    const unavailable: KodiLogResponse = { available: false, lines: [], truncated: false };
    if (!this.dir) return unavailable;
    const wanted = Math.min(Math.max(Math.trunc(lines) || 1, 1), MAX_KODI_LOG_LINES);
    let file;
    try {
      file = await open(join(this.dir, FILE_NAME), 'r');
    } catch {
      return unavailable;
    }
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - CHUNK_BYTES);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      let truncated = start > 0;
      if (truncated) {
        // The chunk begins mid-line (and maybe mid-character): drop that first piece.
        const newline = text.indexOf('\n');
        text = newline < 0 ? '' : text.slice(newline + 1);
      }
      const all = text.split(/\r?\n/);
      if (all.at(-1) === '') all.pop();
      if (all.length > wanted) truncated = true;
      return { available: true, lines: all.slice(-wanted).map(redactLine), truncated };
    } catch {
      return unavailable;
    } finally {
      await file.close();
    }
  }
}
