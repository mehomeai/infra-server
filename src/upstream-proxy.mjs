// Authenticated reverse proxy to the pinned upstream OpenBot app (FULL mode).
//
// Phone sends ONLY `Authorization: Bearer <ht1_*>` on the SAME home authority.
// Home validates the session server-side (sessions JOIN devices, SHA-256,
// expiry/revocation; client user_id NEVER trusted), maps 1:1 to the upstream
// user (upstream_users table), and forwards to the private upstream listener
// with a short-lived HMAC assertion (`x-me-home-assertion`). Phone ht1 tokens,
// cookies, and private keys are stripped and never forwarded; upstream private
// tokens (COMPUTER_TOKEN, MANAGED_AGENT_TOKEN, CPK keys, BETTER_AUTH_SECRET)
// live only in home env and are never sent to phone/LLM.
//
// Upstream consumes the assertion via vendor patch
// `vendor/openbot/patches/0001-home-identity-bridge.patch`
// (server/src/home-bridge.ts: AuthService wrapper verifying the HMAC with
// ME_HOME_BRIDGE_SECRET, then returning the mapped {id,email,role} principal
// to the existing requireUser/createRequestActor guards — no guard bypassed,
// no shared admin, no cookie forge). The bridge is a dedicated secret,
// separate from KEY_ENCRYPTION_KEY/BETTER_AUTH_SECRET/tokens.
//
// Native REST is the phone primary (delivery/channels/agents/tasks/...);
// /api/copilotkit stays mounted (same authority, bounded relay) for the
// upstream-internal native pipeline only — not the phone path. Intelligence
// gateway WS is NEVER exposed to phone. The upstream channel-events WS
// (/api/channels/events) has no home tunnel: it answers 501
// ws_tunnel_pending (known path, unsupported transport), never a fake stream.
// Primary realtime is native REST polling + native push delivery.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticate } from './server.mjs';
import { ensureUpstreamUser, getUpstreamUser } from './upstream-identity.mjs';

export const ASSERTION_HEADER = 'x-me-home-assertion';
export const ASSERTION_VERSION = 'v2';
const ASSERTION_TTL_MS = 60_000;
const ASSERTION_NONCE_BYTES = 16;

// Exact native route allowlist, matched on whole path segments (never raw
// string prefixes: /api/agentsXYZ does NOT match /api/agents). Legacy
// /v1/* stays home (compat facade). Everything else 404s on home (never
// silently legacy). Deliberately NOT proxied: /api/agent-tools/* (private
// harness callback credential), /api/auth/* + /api/admin/* + identity/
// telemetry/browser/voice/recorder/host-access (upstream operator surfaces),
// /health + /api/capabilities (home serves its own).
const PROXY_ROUTES = [
  { segments: ['api', 'copilotkit'], methods: ['GET', 'POST'] },
  { segments: ['api', 'agents'], methods: ['GET', 'POST'] },
  { segments: ['api', 'channels'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { segments: ['api', 'delivery'], methods: ['GET', 'POST', 'DELETE'] },
  { segments: ['api', 'tasks'], methods: ['GET', 'POST'] },
  { segments: ['api', 'proactive'], methods: ['GET', 'POST', 'DELETE'] },
  { segments: ['api', 'routines'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { segments: ['api', 'memory'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { segments: ['api', 'approvals'], methods: ['GET', 'POST'] },
  { segments: ['api', 'computers'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { segments: ['api', 'attachments'], methods: ['GET', 'POST', 'DELETE'] },
  { segments: ['api', 'bots'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { segments: ['api', 'groups'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { segments: ['api', 'route'], methods: ['GET', 'POST'] },
];

// Known native paths home cannot transport yet (explicit 501, not a fake).
const PENDING_PATHS = [
  ['api', 'channels', 'events'],
];

export function splitSegments(pathname) {
  return String(pathname).split('/').filter((s) => s.length > 0);
}

function segmentsMatch(route, segments) {
  if (segments.length < route.length) return false;
  return route.every((s, i) => segments[i] === s);
}

// 'proxy' | 'pending' (known, unsupported transport) | 'deny'.
// Method allowlist included: wrong method => { route: 'deny', status: 405 }.
export function classifyProxyPath(pathname, method = 'GET') {
  const segments = splitSegments(pathname);
  const upper = String(method).toUpperCase();
  if (PENDING_PATHS.some((p) => segmentsMatch(p, segments))) return { route: 'pending' };
  for (const entry of PROXY_ROUTES) {
    if (segmentsMatch(entry.segments, segments)) {
      if (!entry.methods.includes(upper)) return { route: 'deny', status: 405 };
      return { route: 'proxy' };
    }
  }
  return { route: 'deny', status: 404 };
}

export function isProxiedPath(pathname, method = 'GET') {
  return classifyProxyPath(pathname, method).route === 'proxy';
}

export function proxyError(message, code = 'upstream_unavailable', status = 502) {
  return Object.assign(new Error(message), { code, status });
}

// v2.userId.exp.role.nonce.mac — HMAC-SHA256 over the dot-joined first five
// with the dedicated home bridge secret (ME_HOME_BRIDGE_SECRET, server-side
// on both hosts, never sent to phones). Nonce = 128-bit random per request,
// accepted exactly once upstream (replay refused). Must match the wire
// format verified by vendor patch server/src/home-bridge.ts exactly.
export function signHomeAssertion({ upstreamUserId, role, bridgeSecret, now = Date.now(), ttlMs = ASSERTION_TTL_MS }) {
  const key = bridgeSecret ?? null;
  if (!key) throw proxyError('ME_HOME_BRIDGE_SECRET required for home assertion', 'upstream_not_configured', 503);
  if (!upstreamUserId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(upstreamUserId)) {
    throw proxyError('invalid upstream user id for home assertion', 'upstream_misconfigured', 500);
  }
  if (role !== 'admin' && role !== 'user') throw proxyError('invalid role for home assertion', 'upstream_misconfigured', 500);
  const exp = now + ttlMs;
  const nonce = randomBytes(ASSERTION_NONCE_BYTES).toString('hex');
  const payload = `${ASSERTION_VERSION}.${upstreamUserId}.${exp}.${role}.${nonce}`;
  const mac = createHmac('sha256', key).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

export function verifyHomeAssertion(value, { bridgeSecret, now = Date.now() } = {}) {
  const key = bridgeSecret ?? null;
  if (typeof value !== 'string' || !key) return null;
  const parts = value.split('.');
  if (parts.length !== 6) return null;
  const [version, userId, expRaw, role, nonceHex, mac] = parts;
  if (version !== ASSERTION_VERSION) return null;
  const exp = Number(expRaw);
  if (!userId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(userId)) return null;
  if (!/^[0-9a-f]{32}$/.test(nonceHex ?? '')) return null;
  if (!Number.isFinite(exp) || exp <= now) return null;
  if (role !== 'admin' && role !== 'user') return null;
  const payload = `${version}.${userId}.${expRaw}.${role}.${nonceHex}`;
  const expected = createHmac('sha256', key).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(mac, 'hex');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { upstreamUserId: userId, role, exp };
}

export function upstreamBase(env = process.env) {
  const base = String(env.UPSTREAM_SERVER_URL ?? env.ME_UPSTREAM_SERVER_URL ?? 'http://127.0.0.1:3001').trim().replace(/\/$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base) && !base.startsWith('http://upstream:')) {
    // Private listener only: loopback or the compose-internal name. Never a
    // public URL (the upstream app holds the computer plane + DB creds).
    throw proxyError('UPSTREAM_SERVER_URL must be a private loopback/compose address', 'upstream_misconfigured', 500);
  }
  return base;
}

// Bounds for the upstream relay (same discipline as the home API: bounded
// request/response, hard deadlines, no redirect following, no streaming
// without a cap). SSE/CopilotKit included: cut at cap+deadline, documented.
export const PROXY_TIMEOUT_MS = 30_000;
export const PROXY_MAX_JSON_BYTES = 1_000_000;
export const PROXY_MAX_ATTACHMENT_BYTES = 16_000_000;

function maxBytesFor(pathname) {
  const segments = splitSegments(pathname);
  if (segments[1] === 'attachments' || segments[1] === 'channels') return PROXY_MAX_ATTACHMENT_BYTES;
  return PROXY_MAX_JSON_BYTES;
}

// Response headers safe to relay to the phone. Everything else —
// set-cookie, hop-by-hop framing, server internals, private redirects —
// is dropped, never forwarded.
const RELAY_RESPONSE_HEADERS = new Set(['content-type']);

export function filterRelayHeaders(upstreamHeaders) {
  const out = {};
  const get = typeof upstreamHeaders?.get === 'function'
    ? (k) => upstreamHeaders.get(k)
    : (k) => upstreamHeaders?.[k.toLowerCase()] ?? upstreamHeaders?.[k];
  for (const name of RELAY_RESPONSE_HEADERS) {
    const value = get(name);
    if (typeof value === 'string' && value) out[name] = value.slice(0, 256);
  }
  return out;
}

// Server-side forward for a validated Me session: map 1:1, sign, forward
// with ONLY the assertion credential (+ content-type). Phone headers,
// cookies, tokens, forged x-me-* and private keys are never forwarded.
// Upstream 4xx/5xx are returned (bounded buffer), not rewritten; redirects
// are refused (never leak Location); home-side refusals throw proxyError.
export async function forwardNative({ db, session, pathname, search = '', method = 'GET', body, bodyBytes, env = process.env, fetchImpl = fetch, timeoutMs = PROXY_TIMEOUT_MS, maxBytes = null }) {
  if (!session?.user_id) throw proxyError('Valid Bearer session token required', 'unauthorized', 401);
  const verdict = classifyProxyPath(pathname, method);
  if (verdict.route === 'pending') throw proxyError('Channel live events have no home tunnel yet (polling + push primary)', 'ws_tunnel_pending', 501);
  if (verdict.route !== 'proxy') throw proxyError('Unknown route', 'not_found', verdict.status ?? 404);
  const base = upstreamBase(env);
  let linked = getUpstreamUser(db, session.user_id);
  if (!linked) {
    linked = ensureUpstreamUser(db, session.user_id, { env });
  }
  const assertion = signHomeAssertion({ upstreamUserId: linked.upstream_user_id, role: linked.role, bridgeSecret: env.ME_HOME_BRIDGE_SECRET });
  const fwdHeaders = { [ASSERTION_HEADER]: assertion };
  let payload;
  if (bodyBytes != null) {
    payload = bodyBytes.length > 0 ? bodyBytes : undefined;
    if (bodyBytes.length > 0) fwdHeaders['content-type'] = 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    fwdHeaders['content-type'] = 'application/json';
  }
  const cap = maxBytes ?? maxBytesFor(pathname);
  let res;
  try {
    res = await fetchImpl(`${base}${pathname}${search}`, {
      method,
      headers: fwdHeaders,
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw proxyError(`Upstream unavailable: ${error.message}`, 'upstream_unavailable', 502);
  }
  if (res.status >= 300 && res.status < 400) {
    throw proxyError('Upstream refused with a redirect (private location never relayed)', 'upstream_redirect', 502);
  }
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    throw proxyError(`Upstream body unreadable: ${error.message}`, 'upstream_unavailable', 502);
  }
  if (buf.length > cap) {
    throw proxyError(`Upstream response exceeds relay cap (${buf.length} > ${cap} bytes)`, 'upstream_too_large', 502);
  }
  const text = () => buf.toString('utf8');
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: filterRelayHeaders(res.headers),
    body: buf,
    text,
    json: () => JSON.parse(text() || 'null'),
    upstreamUserId: linked.upstream_user_id,
    role: linked.role,
  };
}

// The single FULL-mode entrypoint used by server.mjs: validate ht1 from the
// request headers, then forwardNative. Throws proxyError (with .status) for
// home-side refusals; upstream 4xx/5xx are relayed bounded, not rewritten.
export async function proxyToUpstream({ db, req, pathname, search = '', method, headers, bodyBytes, env = process.env, fetchImpl = fetch, timeoutMs = PROXY_TIMEOUT_MS, maxBytes = null }) {
  const token = bearerOf(headers);
  const session = token ? authenticate(db, token) : null;
  if (!session) throw proxyError('Valid Bearer session token required', 'unauthorized', 401);
  return forwardNative({ db, session, pathname, search, method, bodyBytes, env, fetchImpl, timeoutMs, maxBytes });
}

function bearerOf(headers) {
  const header = headers.authorization ?? headers.Authorization;
  if (!header) return null;
  const [scheme, value] = String(header).split(' ', 2);
  if (scheme !== 'Bearer' || !value) return null;
  return value;
}

// Capability report for /healthz + /v1/me (additive OPTIONAL fields; absence
// = legacy home). No secrets, no key material, no env values.
// Honest split: configValid = operator env complete (offline); fullConfigured
// = configValid AND fresh bounded live doctor evidence (live={live:true} only
// from a recent READY upstream-platform-v1 run). Env presence alone never
// means configured.
export function capabilityReport(env = process.env, live = { live: false }) {
  const full = (env.ME_UPSTREAM_MODE ?? 'core').trim().toLowerCase() === 'full';
  if (!full) return { agentMode: 'legacy', configValid: true, fullConfigured: false, needsSetup: false };
  const missing = [];
  for (const k of ['UPSTREAM_SERVER_URL', 'DATABASE_URL', 'KEY_ENCRYPTION_KEY', 'ME_HOME_BRIDGE_SECRET', 'INTELLIGENCE_API_URL', 'INTELLIGENCE_GATEWAY_WS_URL', 'CPK_INTELLIGENCE_API_KEY', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'INITIAL_ADMIN_EMAILS', 'COMPUTER_SUPERVISOR_URL', 'SUPERVISOR_TOKEN', 'COMPUTER_TOKEN']) {
    const v = env[k] ?? (k === 'UPSTREAM_SERVER_URL' ? env.ME_UPSTREAM_SERVER_URL : null);
    if (!v || !String(v).trim()) missing.push(k);
  }
  const configValid = missing.length === 0;
  const liveOk = configValid && live?.live === true;
  const liveMissing = configValid && !live?.live ? ['live-doctor-evidence'] : [];
  return {
    agentMode: 'full-upstream',
    configValid,
    fullConfigured: liveOk,
    needsSetup: !liveOk,
    ...((missing.length > 0 || liveMissing.length > 0) ? { missing: [...missing, ...liveMissing] } : {}),
    liveEvidence: live?.live === true ? { fresh: true } : { fresh: false, reason: live?.reason ?? 'missing' },
    // Phone primary is native REST on this same authority (proxied after
    // ht1 validation + server-side assertion). /api/copilotkit stays mounted
    // for the upstream-internal native pipeline; it is not the phone path.
    transports: ['native-rest'],
    nativeMounts: [
      '/api/agents',
      '/api/channels',
      '/api/delivery',
      '/api/tasks',
      '/api/approvals',
      '/api/computers',
      '/api/attachments',
      '/api/proactive',
      '/api/routines',
      '/api/memory',
    ],
    // No WS tunnel is advertised: /api/channels/events exists upstream but
    // has no home transport (501 ws_tunnel_pending). Primary realtime is
    // native REST polling + native push delivery.
    realtimeSocket: null,
    realtime: 'polling+push (no ws tunnel advertised)',
    runtimeMount: '/api/copilotkit',
  };
}
