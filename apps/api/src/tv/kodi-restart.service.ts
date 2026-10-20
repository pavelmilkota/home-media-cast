import { writeFile } from 'node:fs/promises';

/** Restart was asked for again before the cool-down ended. */
export class RestartRateLimitedError extends Error {
  constructor(readonly retryAfterS: number) {
    super(`Kodi was just asked to restart. Try again in ${retryAfterS} s`);
  }
}

/** The trigger file cannot be written (not configured, missing or read-only directory). */
export class RestartUnavailableError extends Error {}

export const RESTART_COOLDOWN_MS = 30_000;

/**
 * "Restart Kodi" without privileges: the API container only creates an empty file, and a unit
 * on the host (scripts/kodi-restart.*) does the restarting (ADR-0008). The file has no content,
 * so nothing a caller sends can reach the host.
 */
export class KodiRestartService {
  private lastAt: number | undefined;

  constructor(
    private readonly triggerPath: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async request(): Promise<void> {
    const t = this.now();
    if (this.lastAt !== undefined && t - this.lastAt < RESTART_COOLDOWN_MS) {
      throw new RestartRateLimitedError(
        Math.ceil((RESTART_COOLDOWN_MS - (t - this.lastAt)) / 1000),
      );
    }
    if (!this.triggerPath) {
      throw new RestartUnavailableError('Restarting Kodi is not set up on this server');
    }
    try {
      await writeFile(this.triggerPath, '');
    } catch {
      throw new RestartUnavailableError(
        'The server cannot create the restart request (see docs/kodi-setup.md)',
      );
    }
    this.lastAt = t; // only a request that was written uses up the cool-down
  }
}
