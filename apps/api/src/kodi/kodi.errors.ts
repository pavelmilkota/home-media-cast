/** The backend cannot talk to Kodi right now (not connected, or the connection dropped). */
export class KodiUnavailableError extends Error {
  override readonly name = 'KodiUnavailableError';
}

/** Kodi did not answer within the request timeout. */
export class KodiTimeoutError extends Error {
  override readonly name = 'KodiTimeoutError';
  constructor(method: string, timeoutMs: number) {
    super(`Kodi did not answer ${method} within ${timeoutMs} ms`);
  }
}

/** Kodi answered with a JSON-RPC error object. */
export class KodiRpcError extends Error {
  override readonly name = 'KodiRpcError';
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** A command needs a running player and Kodi has none. */
export class KodiNoActivePlayerError extends Error {
  override readonly name = 'KodiNoActivePlayerError';
  constructor() {
    super('Kodi has no active player');
  }
}

/** A URL handed to Kodi is not a plain http(s) URL. */
export class KodiInvalidUrlError extends Error {
  override readonly name = 'KodiInvalidUrlError';
}
