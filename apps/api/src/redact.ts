const SENSITIVE =
  /^(token|apikey|api_key|key|password|passwd|secret|auth|authorization|access_token|uuid)$/i;
const MASK = '***';

/** The relay id is a capability: keep it out of request logs. */
const RELAY_PATH = /(\/api\/relay\/)[^/?#]+/;

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
