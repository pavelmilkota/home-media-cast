const SENSITIVE =
  /^(token|apikey|api_key|key|password|passwd|secret|auth|authorization|access_token|uuid)$/i;
const MASK = '***';

/**
 * The relay id and the browser session id are capabilities: keep them out of request logs. The
 * session id appears in `/api/media/<id>/...` (public) and `/api/browser-play/<id>/...`.
 */
// `browser-play/external/<id>` too, but not the word `external` itself (the start route).
const RELAY_PATH =
  /(\/api\/(?:relay|media|browser-play)\/(?:external\/)?)(?!external(?:[/?#]|$))[^/?#]+/;

/**
 * For logging a URL that came from a provider: host only. Its path and query can hold a key
 * (`/resolve/<service>/<key>/…`, `/api/v1/proxy/<blob>/…`, `?token=<key>`).
 */
export function redactProviderUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '(unparseable url)';
  }
}

/** Masks values of sensitive query parameters and drops credentials embedded in a URL. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw, 'http://placeholder.invalid');
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE.test(key)) url.searchParams.set(key, MASK);
    }
    const out = relative ? url.pathname + url.search + url.hash : url.href;
    return out.replace(RELAY_PATH, '$1***');
  } catch {
    // Not parseable: better to log nothing than a token.
    return raw.split(/[?#]/)[0] ?? '';
  }
}

/** Deep copy with sensitive keys masked; for logging objects such as request bodies. */
export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? MASK : redactObject(v)]),
    );
  }
  return value;
}

const RELAY_PATH_ALL =
  /(\/api\/(?:relay|media|browser-play)\/(?:external\/)?)(?!external(?:[/?#\s]|$))[^/?#\s'"<>)]+/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@'"<>]+@/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
/** `token=…`, `"api_key": "…"`, `Authorization: Bearer …`, also inside a query string. */
const SENSITIVE_PAIR =
  /\b((?:[\w-]*(?:token|apikey|api[_-]key|password|passwd|secret|authorization|uuid))|key|auth)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"'&,;}<>)\]]+/gi;

/**
 * Masks secrets in a free-text log line (Kodi's log, Nest's output). Leaves a line with nothing
 * to hide exactly as it was.
 */
export function redactLine(line: string): string {
  try {
    return line
      .replace(URL_CREDENTIALS, '$1')
      .replace(RELAY_PATH_ALL, '$1***')
      .replace(BEARER, '$1***')
      .replace(SENSITIVE_PAIR, `$1$2${MASK}`);
  } catch {
    return '(unprintable line)';
  }
}
