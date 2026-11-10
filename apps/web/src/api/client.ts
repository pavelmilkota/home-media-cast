import { auth } from './auth.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /** The rest of the error body, e.g. the `pick` of a `handoff_pick_source`. */
    readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Public endpoints (health, pairing) are called without the token and never log out. */
  auth?: boolean;
  /**
   * Sends the token but a 401 does not clear it. For pairing from a guest session: a wrong code
   * answers 401, and logging the guest out would end the film it is watching.
   */
  keepToken?: boolean;
}

/** Nest answers validation errors with an array of messages and others with a string. */
function messageOf(body: unknown, fallback: string): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : fallback;
}

export async function api<T = void>(path: string, opts: Options = {}): Promise<T> {
  const { method = 'GET', body, auth: authed = true, keepToken = false } = opts;
  const token = auth.get();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authed && token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the backend');
  }
  if (res.ok) {
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  const payload = (await res.json().catch(() => null)) as
    ({ error?: string } & Record<string, unknown>) | null;
  if (res.status === 401 && authed && token && !keepToken) auth.clear(); // revoked or unknown token
  throw new ApiError(
    res.status,
    payload?.error,
    messageOf(payload, `Request failed (${res.status})`),
    payload ?? undefined,
  );
}
