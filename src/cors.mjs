// Exact-origin CORS allowlist (Codex autosync plan step 6).
//
// Boundary: cross-origin browser access is granted ONLY to origins listed
// verbatim in ME_CORS_ALLOWED_ORIGINS (comma-separated serialized origins:
// scheme + host + optional port, no path, no trailing slash). Unset/empty
// means NO CORS headers are ever emitted — the historical fail-closed
// behavior. There is no wildcard and no origin reflection beyond an exact
// allowlist match.
//
// Credentials: Access-Control-Allow-Credentials is deliberately NOT sent.
// Every client of this service authenticates with an explicit
// `Authorization: Bearer ht1_...` session header (or credentials in the
// /v1/pair and /v1/sessions request bodies); no client uses cookies or
// other ambient credentials, so credentialed CORS mode is unnecessary
// attack surface.

export const CORS_ENV_VAR = 'ME_CORS_ALLOWED_ORIGINS';

// Methods the home API actually routes, and the non-simple request headers
// its clients send cross-origin.
export const CORS_ALLOWED_METHODS = 'GET, POST';
export const CORS_ALLOWED_HEADERS = 'Authorization, Content-Type';
export const CORS_MAX_AGE_SECONDS = '600';

// Parse the env value into a Set of exact origins. Throws on any entry that
// is not a serialized http(s) origin — a malformed allowlist is a config
// error and must fail loudly at startup, never silently widen or narrow.
export function parseCorsAllowedOrigins(raw) {
  const origins = new Set();
  if (raw === undefined || raw === null) return origins;
  const values = Array.isArray(raw) ? raw : raw instanceof Set ? [...raw] : String(raw).split(',');
  for (const entry of values) {
    const origin = String(entry).trim();
    if (!origin) continue;
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`${CORS_ENV_VAR}: entry is not a valid origin: ${JSON.stringify(origin)}`);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) {
      throw new Error(
        `${CORS_ENV_VAR}: entry must be an exact origin (scheme + host + optional port, no path): ${JSON.stringify(origin)}`,
      );
    }
    origins.add(origin);
  }
  return origins;
}

// The request's Origin header when it is an exact allowlist match, else null.
export function corsMatchOrigin(req, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.size === 0) return null;
  const origin = req.headers?.origin;
  if (typeof origin !== 'string') return null;
  return allowedOrigins.has(origin) ? origin : null;
}

// True for a real CORS preflight (OPTIONS + Origin + request-method).
export function isCorsPreflight(req) {
  return (
    req.method === 'OPTIONS'
    && typeof req.headers?.origin === 'string'
    && typeof req.headers?.['access-control-request-method'] === 'string'
  );
}

// Handle an OPTIONS request at the outermost layer. Returns true when the
// request was fully answered here:
// - allowed origin preflight  -> 204 with the allowlist grants
// - disallowed origin preflight -> 403, no CORS headers, nothing granted
// Non-preflight OPTIONS requests return false and route as before.
export function handleCorsPreflight(req, res, allowedOrigins) {
  // Unconfigured (empty allowlist) = feature off: route exactly as before.
  if (!allowedOrigins || allowedOrigins.size === 0) return false;
  if (!isCorsPreflight(req)) return false;
  const origin = corsMatchOrigin(req, allowedOrigins);
  if (!origin) {
    res.writeHead(403, { 'content-length': 0 });
    res.end();
    return true;
  }
  res.writeHead(204, {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': CORS_ALLOWED_METHODS,
    'access-control-allow-headers': CORS_ALLOWED_HEADERS,
    'access-control-max-age': CORS_MAX_AGE_SECONDS,
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    'content-length': 0,
  });
  res.end();
  return true;
}

// Stamp the actual-response headers for an allowed origin. Callers invoke
// this before routing so error responses (401/403/404) carry the headers
// too — without them a browser cannot even read the error body.
export function applyCorsHeaders(res, origin) {
  if (!origin) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
}
