import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { openHomeDb, closeHomeDb } from './db.mjs';
import {
  hashSecret,
  isSessionTokenFormat,
  newSecret,
  newSessionToken,
  verifySecret,
} from './auth.mjs';
import { newId, isUuid } from './ids.mjs';
import { createTaskBroker, withDeadline } from './task-broker.mjs';
import {
  resolveCapabilityPolicy,
  resolveModelConfig,
  resolveRuntimeCommand,
} from './runtime-config.mjs';
import { createRateLimiter, clientIp, resolveRateLimit } from './rate-limit.mjs';
import {
  createDisabledProvider,
  createExpoHttpProvider,
  createNotificationService,
  resolveNotificationConfig,
} from './notifications.mjs';
import { createCoordinator } from './coordinator.mjs';
import {
  capabilityReport,
  classifyProxyPath,
  forwardNative,
  proxyToUpstream,
} from './upstream-proxy.mjs';
import { doctorCachePath } from './upstream-doctor.mjs';
import { createLiveTracker } from './upstream-live.mjs';
import {
  parseCorsAllowedOrigins,
  corsMatchOrigin,
  handleCorsPreflight,
  applyCorsHeaders,
} from './cors.mjs';
import { submitToUpstream } from './upstream-full.mjs';

export const CONTRACT_VERSION = 'home-api-v1';
export const DEFAULT_PORT = 7070;
export const DEFAULT_HOST = '127.0.0.1';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const INVITATION_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 1_000_000;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function fail(res, status, code, message, headers = {}) {
  const payload = JSON.stringify({ error: { code, message } });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return parseJsonBody(Buffer.concat(chunks));
}

function parseJsonBody(raw) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ', 2);
  if (scheme !== 'Bearer' || !value) return null;
  return value;
}

export function ensureUser(db, id, displayName) {
  const clean = String(id).trim();
  if (!clean || clean.length > 128) throw new Error('Invalid user id');
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(clean);
  if (!existing) {
    db.prepare('INSERT INTO users(id, display_name, created_at) VALUES(?, ?, ?)').run(
      clean,
      String(displayName ?? clean),
      Date.now(),
    );
  }
  return clean;
}

// Explicit local bootstrap: called by the on-host CLI (filesystem access is
// the authorization), never exposed over HTTP.
export function createInvitation(db, userId, ttlMs = INVITATION_TTL_MS) {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  const id = newId('inv');
  const secret = newSecret(32);
  const now = Date.now();
  db.prepare(
    'INSERT INTO invitations(id, user_id, secret_hash, created_at, expires_at, consumed_at) VALUES(?, ?, ?, ?, ?, NULL)',
  ).run(id, userId, hashSecret(secret), now, now + ttlMs);
  return { invitation_id: id, invitation_secret: secret, expires_at: now + ttlMs };
}

// Authenticate a session bearer token against current revocation/expiry.
// Identity always derives from this lookup; client-supplied user/role fields
// are never trusted.
export function authenticate(db, token) {
  if (!isSessionTokenFormat(token)) return null;
  const row = db
    .prepare(
      `SELECT s.device_id, s.user_id, s.expires_at, s.revoked_at AS session_revoked,
              d.revoked_at AS device_revoked
         FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE s.token_hash = ?`,
    )
    .get(hashSecret(token));
  if (!row) return null;
  const now = Date.now();
  if (row.session_revoked != null || row.device_revoked != null) return null;
  if (row.expires_at <= now) return null;
  return { user_id: row.user_id, device_id: row.device_id };
}

function pairDevice(db, installationId, body) {
  const { invitation_id, invitation_secret, device_label, installation_id } = body ?? {};
  if (installation_id != null && installation_id !== installationId) {
    return { status: 403, code: 'wrong_home', message: 'Invitation is not for this home' };
  }
  if (typeof invitation_id !== 'string' || typeof invitation_secret !== 'string') {
    return { status: 400, code: 'bad_request', message: 'invitation_id and invitation_secret are required' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const inv = db
      .prepare('SELECT id, user_id, secret_hash, expires_at, consumed_at FROM invitations WHERE id = ?')
      .get(invitation_id);
    const now = Date.now();
    if (!inv) {
      db.exec('ROLLBACK');
      return { status: 404, code: 'invitation_not_found', message: 'Unknown invitation' };
    }
    if (inv.consumed_at != null) {
      db.exec('ROLLBACK');
      return { status: 410, code: 'invitation_consumed', message: 'Invitation already used' };
    }
    if (inv.expires_at <= now) {
      db.exec('ROLLBACK');
      return { status: 410, code: 'invitation_expired', message: 'Invitation expired' };
    }
    if (!verifySecret(invitation_secret, inv.secret_hash)) {
      db.exec('ROLLBACK');
      return { status: 403, code: 'invalid_invitation', message: 'Invalid invitation secret' };
    }
    const consumed = db
      .prepare('UPDATE invitations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .run(now, invitation_id);
    if (consumed.changes !== 1) {
      db.exec('ROLLBACK');
      return { status: 410, code: 'invitation_consumed', message: 'Invitation already used' };
    }
    const deviceId = newId('dev');
    const deviceSecret = newSecret(32);
    db.prepare(
      'INSERT INTO devices(id, user_id, label, secret_hash, created_at, revoked_at) VALUES(?, ?, ?, ?, ?, NULL)',
    ).run(
      deviceId,
      inv.user_id,
      String(device_label ?? 'phone').slice(0, 128),
      hashSecret(deviceSecret),
      now,
    );
    db.exec('COMMIT');
    return {
      status: 201,
      body: {
        device_id: deviceId,
        device_secret: deviceSecret,
        user_id: inv.user_id,
        installation_id: installationId,
      },
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

// Store a caller-submitted user message with optional idempotency. When the
// caller supplies request_key (a client-generated UUID), a network retry with
// the same key and byte-identical body+role returns the original message
// (200, duplicate:true) instead of creating a duplicate; the same key with a
// different payload is a 409 conflict. Keys bind to (conversation, author):
// another user reusing a key gets an independent message.
function storeMessage(db, conv, session, body) {
  const role = body?.role ?? 'user';
  if (role !== 'user') {
    return { ok: false, status: 400, code: 'unsupported_role', message: 'This slice accepts role "user" only; model output is out of scope' };
  }
  if (typeof body?.body !== 'string' || !body.body.trim() || body.body.length > 20000) {
    return { ok: false, status: 400, code: 'bad_request', message: 'body must be non-empty text up to 20000 chars' };
  }
  const key = body?.request_key ?? null;
  if (key !== null && !isUuid(key)) {
    return { ok: false, status: 400, code: 'bad_request', message: 'request_key must be a UUID' };
  }
  const now = Date.now();
  if (key !== null) {
    const existing = db
      .prepare('SELECT id, conversation_id, author_user_id, author_device_id, role, body, request_key, task_id, created_at FROM messages WHERE conversation_id = ? AND author_user_id = ? AND request_key = ?')
      .get(conv.id, session.user_id, key);
    if (existing) {
      if (existing.body === body.body && existing.role === role) {
        return { ok: true, status: 200, record: { ...existing, duplicate: true } };
      }
      return { ok: false, status: 409, code: 'request_key_conflict', message: 'request_key already used with a different payload' };
    }
  }
  const id = newId('msg');
  const row = {
    id,
    conversation_id: conv.id,
    author_user_id: session.user_id,
    author_device_id: session.device_id,
    role: 'user',
    body: body.body,
    request_key: key,
    task_id: null,
    created_at: now,
  };
  try {
    db.prepare(
      'INSERT INTO messages(id, conversation_id, author_user_id, author_device_id, role, body, request_key, task_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    ).run(id, conv.id, session.user_id, session.device_id, 'user', body.body, key, now);
  } catch (error) {
    // Lost a same-key race: re-read and apply retry semantics.
    if (key !== null && String(error?.message ?? '').includes('UNIQUE')) {
      return storeMessage(db, conv, session, body);
    }
    throw error;
  }
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conv.id);
  return { ok: true, status: 201, record: { ...row, duplicate: false } };
}

export function createHomeServer({ dbPath, broker: brokerOverrides = {}, rateLimit: rateLimitOverrides, env = process.env, notifications: notificationOverrides = {}, coordinator: coordinatorOverrides = {}, upstreamFetch = fetch, liveIntervalMs = 120_000, liveTtlMs = null, liveFullIntervalMs = null, liveKick = true } = {}) {
  // Exact-origin CORS allowlist from ME_CORS_ALLOWED_ORIGINS; unset = no
  // CORS headers (fail-closed). Throws on a malformed entry.
  const corsAllowedOrigins = parseCorsAllowedOrigins(env.ME_CORS_ALLOWED_ORIGINS);
  const { db, installationId } = openHomeDb(dbPath);
  // H8 coordinator (disabled by default): consumes the S7-written private
  // credentials file and heartbeats the hosted backend. No outbound network
  // unless HOME_COORDINATOR_CREDENTIALS_FILE is set. Private home/tasks/
  // pairing keep working when disabled or misconfigured.
  const coordinator = coordinatorOverrides.service
    ?? createCoordinator({ installationId, env, fetchImpl: coordinatorOverrides.fetchImpl ?? null });
  // H7 notification service (default constructor-injected seam for tests).
  // Disabled by default: no outbound network unless the operator opts in via
  // HOME_NOTIFICATIONS_ENABLED=1. Tests inject a fake provider + enabled
  // config; production uses the fixed Expo HTTPS endpoints (no new deps).
  let notificationConfig;
  try {
    notificationConfig = notificationOverrides.config ?? resolveNotificationConfig(env);
  } catch (error) {
    notificationConfig = { enabled: false, configError: error.message };
  }
  const notificationProvider = notificationOverrides.provider
    ?? (notificationConfig.enabled
      ? createExpoHttpProvider({ accessToken: notificationConfig.accessToken ?? null, timeoutMs: notificationConfig.sendTimeoutMs ?? 8000 })
      : createDisabledProvider());
  const notifications = notificationOverrides.service
    ?? createNotificationService({ db, installationId, config: notificationConfig, provider: notificationProvider, store: null });
  let runtime = brokerOverrides.runtime;
  let model;
  let modelError = null;
  let runtimeError = null;
  if (!brokerOverrides.model && !brokerOverrides.modelError) {
    try {
      model = resolveModelConfig(env);
    } catch (error) {
      modelError = error.message;
    }
    try {
      runtime = resolveRuntimeCommand(env);
    } catch (error) {
      runtimeError = error.message;
      runtime = { command: ['python3', '-m', 'me_runtime.bridge'], cwd: undefined };
    }
  } else {
    model = brokerOverrides.model ?? null;
    modelError = brokerOverrides.modelError ?? null;
    runtimeError = brokerOverrides.runtimeError ?? null;
    runtime = runtime ?? { command: ['python3', '-m', 'me_runtime.bridge'], cwd: undefined };
  }
  const broker = createTaskBroker({
    db,
    installationId,
    tasksRoot: brokerOverrides.tasksRoot ?? join(dirname(dbPath), 'tasks'),
    runtime,
    runtimeError,
    model,
    modelError,
    capabilities: brokerOverrides.capabilities ?? resolveCapabilityPolicy(env),
    pollMs: brokerOverrides.pollMs ?? Number(env.HOME_POLL_MS ?? 1000),
    termination: brokerOverrides.termination,
    delegation: brokerOverrides.delegation,
    notifications,
    env,
  });
  // Failed-auth rate limiting (H5): bounded per-IP failure buckets on the two
  // credential routes. Trusts only the direct peer unless HOME_TRUST_PROXY=1
  // with a loopback peer (see rate-limit.mjs).
  const authLimiter = createRateLimiter(rateLimitOverrides ?? resolveRateLimit(env));
  // In-home live evidence (FULL): bounded background singleflight refresh;
  // the capability path reads the in-memory snapshot and never awaits the
  // network. Cache path is shared with the CLI/doctor runs:
  // $ME_DATA_DIR/doctor-cache.json when HOME_DB lives there.
  const liveTracker = createLiveTracker({
    env,
    fetchImpl: upstreamFetch,
    intervalMs: liveIntervalMs,
    ...(liveTtlMs == null ? {} : { ttlMs: liveTtlMs }),
    ...(liveFullIntervalMs == null ? {} : { fullIntervalMs: liveFullIntervalMs }),
    cachePath: env.ME_DOCTOR_CACHE ?? doctorCachePath(dbPath),
  });
  let http = null;

  // Returns true when the request must stop here (429 already sent).
  function checkAuthRate(req, res) {
    const ip = clientIp(req, env);
    const verdict = authLimiter.check(ip);
    if (verdict.limited) {
      const retryAfter = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      fail(res, 429, 'rate_limited', 'Too many failed attempts; try again later', {
        'retry-after': String(retryAfter),
      });
      return true;
    }
    return false;
  }

  function noteAuthOutcome(req, status) {
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      authLimiter.fail(clientIp(req, env));
    } else if (status === 201) {
      authLimiter.reset(clientIp(req, env));
    }
  }

  async function handle(req, res) {
    // CORS outermost layer: preflights are answered here (before auth, so
    // a browser can negotiate without a session); for an allowlisted
    // origin the grant headers are stamped before routing so every
    // response — including 401/403/404 errors — carries them.
    if (handleCorsPreflight(req, res, corsAllowedOrigins)) return;
    applyCorsHeaders(res, corsMatchOrigin(req, corsAllowedOrigins));

    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    // Minimal anonymous health surface only. No user/device/data details here.
    // Additive FULL capability fields (absence = legacy home). fullConfigured
    // requires fresh bounded live doctor evidence, never env presence alone.
    // Synchronous in-memory read: fast health/pairing never await the network.
    const liveEvidence = () => {
      try {
        return liveTracker.get();
      } catch {
        return { live: false, reason: 'missing' };
      }
    };
    if (method === 'GET' && pathname === '/healthz') {
      send(res, 200, { status: 'ok', installation_id: installationId, contract: CONTRACT_VERSION, ...capabilityReport(env, liveEvidence()) });
      return;
    }
    if (method === 'GET' && pathname === '/readyz') {
      try {
        db.prepare('SELECT value FROM meta WHERE key = ?').get('installation_id');
        send(res, 200, { ready: true, installation_id: installationId });
      } catch {
        fail(res, 503, 'not_ready', 'Storage unavailable');
      }
      return;
    }
    // Full-platform readiness (OPEN #4): synchronous in-memory read of the
    // two-tier handshake evidence — 200 only when the FULL tier (fleet /
    // role gate / model-served incl. container-namespace proof) holds
    // fresh passing evidence. /readyz above stays storage-only on purpose
    // (setup-infra lifecycle waits depend on that meaning).
    if (method === 'GET' && pathname === '/readyz/full') {
      let fullView;
      try {
        fullView = liveTracker.getFull();
      } catch {
        fullView = { ready: false, reason: 'missing', at: Date.now(), checks: null };
      }
      if (fullView.ready) {
        send(res, 200, { ready: true, at: fullView.at, checks: fullView.checks });
      } else {
        send(res, 503, { ready: false, at: fullView.at, reason: fullView.reason ?? 'not-ready', checks: fullView.checks });
      }
      return;
    }

    if (method === 'POST' && pathname === '/v1/pair') {
      if (checkAuthRate(req, res)) return;
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        fail(res, error.status ?? 400, 'bad_request', error.message);
        return;
      }
      const out = pairDevice(db, installationId, body);
      noteAuthOutcome(req, out.status);
      if (out.body) send(res, out.status, out.body);
      else fail(res, out.status, out.code, out.message);
      return;
    }

    // NOTE: this route is credential-authenticated (device_id + device_secret
    // in the JSON body), not Bearer-session-authenticated. It mints session
    // tokens; it does not consume them.
    if (method === 'POST' && pathname === '/v1/sessions') {
      if (checkAuthRate(req, res)) return;
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        fail(res, error.status ?? 400, 'bad_request', error.message);
        return;
      }
      const { device_id, device_secret } = body ?? {};
      if (typeof device_id !== 'string' || typeof device_secret !== 'string') {
        fail(res, 400, 'bad_request', 'device_id and device_secret are required');
        return;
      }
      const device = db
        .prepare('SELECT id, user_id, secret_hash, revoked_at FROM devices WHERE id = ?')
        .get(device_id);
      if (!device || device.revoked_at != null || !verifySecret(device_secret, device.secret_hash)) {
        noteAuthOutcome(req, 401);
        fail(res, 401, 'invalid_device', 'Unknown device, revoked device, or wrong secret');
        return;
      }
      const token = newSessionToken();
      const now = Date.now();
      db.prepare(
        'INSERT INTO sessions(token_hash, device_id, user_id, created_at, expires_at, revoked_at) VALUES(?, ?, ?, ?, ?, NULL)',
      ).run(hashSecret(token), device.id, device.user_id, now, now + SESSION_TTL_MS);
      noteAuthOutcome(req, 201);
      send(res, 201, {
        token,
        expires_at: now + SESSION_TTL_MS,
        user_id: device.user_id,
        device_id: device.id,
      });
      return;
    }

    // Everything below requires a live, unrevoked session token.
    const session = authenticate(db, bearerToken(req));
    if (!session) {
      fail(res, 401, 'unauthorized', 'Valid Bearer session token required');
      return;
    }

    // FULL primary: native upstream REST behind the same paired authority.
    // Home validated ht1_* above, maps 1:1 server-side and signs a
    // short-lived single-use assertion; upstream consumes it via the
    // home-bridge patch (vendor/openbot/patches/0001). Phone credentials,
    // cookies, forged x-me-* and private keys are stripped and never
    // forwarded; the private listener is never directly reachable.
    // Known-but-untunneled paths (channel live events) answer 501, unknown
    // paths 404/405 — never silently legacy.
    if ((env.ME_UPSTREAM_MODE ?? 'core').trim().toLowerCase() === 'full') {
      const verdict = classifyProxyPath(pathname, method);
      if (verdict.route === 'pending') {
        fail(res, 501, 'ws_tunnel_pending', 'Channel live events have no home tunnel yet (polling + push primary)');
        return;
      }
      if (verdict.route === 'deny' && verdict.status === 405) {
        fail(res, 405, 'method_not_allowed', 'Method not allowed on this native path');
        return;
      }
      if (verdict.route === 'proxy') {
        let bodyBytes = null;
        if (method !== 'GET' && method !== 'HEAD') {
          try {
            bodyBytes = await readRawBody(req);
          } catch (error) {
            fail(res, error.status ?? 400, 'bad_request', error.message);
            return;
          }
        }
        // Client disconnect aborts the upstream call: bounded lifetime both ways.
        const disconnect = new AbortController();
        req.on('close', () => disconnect.abort());
        const headers = {};
        for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        try {
          const out = await proxyToUpstream({
            db, req, pathname, search: url.search ?? '', method, headers, bodyBytes, env, fetchImpl: upstreamFetch,
          });
          if (disconnect.signal.aborted) return;
          const contentType = out.headers['content-type'] ?? 'application/json';
          res.writeHead(out.status, {
            'content-type': contentType,
            'content-length': out.body.length,
            'x-content-type-options': 'nosniff',
          });
          res.end(out.body);
        } catch (error) {
          if (disconnect.signal.aborted) return;
          fail(res, error.status ?? 502, error.code ?? 'upstream_unavailable', String(error.message ?? 'Upstream unavailable').slice(0, 500));
        }
        return;
      }
    }

    if (method === 'GET' && pathname === '/v1/me') {
      send(res, 200, {
        user_id: session.user_id,
        device_id: session.device_id,
        installation_id: installationId,
        ...capabilityReport(env, liveEvidence()),
      });
      return;
    }

    if (method === 'GET' && pathname === '/v1/devices') {
      const rows = db
        .prepare('SELECT id, label, created_at, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at, id')
        .all(session.user_id);
      send(res, 200, { devices: rows });
      return;
    }

    const revokeMatch = pathname.match(/^\/v1\/devices\/([^/]+)\/revoke$/);
    if (method === 'POST' && revokeMatch) {
      const target = db
        .prepare('SELECT id, user_id, revoked_at FROM devices WHERE id = ?')
        .get(revokeMatch[1]);
      // Same-user scope; unknown-or-other-user reads as 404 to avoid oracle.
      if (!target || target.user_id !== session.user_id) {
        fail(res, 404, 'not_found', 'Device not found');
        return;
      }
      const now = Date.now();
      db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, target.id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, target.id);
      // H7: revocation disables push delivery immediately; the outbox pump
      // revalidates and drops any stale rows for this device.
      try { notifications.disableForDevice(target.id); } catch { /* best effort */ }
      const updated = db
        .prepare('SELECT id, label, created_at, revoked_at FROM devices WHERE id = ?')
        .get(target.id);
      send(res, 200, { device: updated });
      return;
    }

    // H7 opt-in push registration (device-me): identity always derives from
    // the session token; client-supplied user/device IDs are rejected.
    // Payload is metadata-only; the raw token is never returned or logged.
    if (method === 'POST' && pathname === '/v1/notifications/register') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        fail(res, error.status ?? 400, 'bad_request', error.message);
        return;
      }
      try {
        const out = notifications.register(session, body);
        send(res, 200, { ...out, installation_id: installationId });
      } catch (error) {
        const code = error?.code ?? 'bad_request';
        const status = code === 'notifications_disabled' ? 403
          : code === 'registration_limit' ? 429
          : code === 'unauthorized' ? 401
          : 400;
        const extra = status === 429 ? { 'retry-after': '60' } : {};
        fail(res, status, code, String(error?.message ?? 'registration failed').slice(0, 500), extra);
      }
      return;
    }

    if (method === 'GET' && (pathname === '/v1/notifications/status' || pathname === '/v1/notifications')) {
      send(res, 200, notifications.statusFor(session));
      return;
    }

    if (method === 'POST' && (pathname === '/v1/notifications/disable' || pathname === '/v1/notifications/unregister')) {
      send(res, 200, notifications.disableForSession(session));
      return;
    }

    // H8 coordinator status (authenticated, redacted): shows configured /
    // liveness only. Never token/prefix/raw errors/account claims.
    if (method === 'GET' && pathname === '/v1/coordinator/status') {
      send(res, 200, coordinator.getStatus());
      return;
    }

    if (method === 'POST' && pathname === '/v1/conversations') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        fail(res, error.status ?? 400, 'bad_request', error.message);
        return;
      }
      const title = String(body?.title ?? 'Untitled').slice(0, 200) || 'Untitled';
      const now = Date.now();
      const id = newId('conv');
      db.prepare(
        'INSERT INTO conversations(id, owner_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?)',
      ).run(id, session.user_id, title, now, now);
      send(res, 201, { id, owner_id: session.user_id, title, created_at: now, updated_at: now });
      return;
    }

    if (method === 'GET' && pathname === '/v1/conversations') {
      const rows = db
        .prepare('SELECT id, owner_id, title, created_at, updated_at FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC, id')
        .all(session.user_id);
      send(res, 200, { conversations: rows });
      return;
    }

    const convMatch = pathname.match(/^\/v1\/conversations\/([^/]+)$/);
    if (method === 'GET' && convMatch) {
      const conv = db
        .prepare('SELECT id, owner_id, title, created_at, updated_at FROM conversations WHERE id = ?')
        .get(convMatch[1]);
      if (!conv || conv.owner_id !== session.user_id) {
        fail(res, 404, 'not_found', 'Conversation not found');
        return;
      }
      send(res, 200, conv);
      return;
    }

    const convTasksMatch = pathname.match(/^\/v1\/conversations\/([^/]+)\/tasks$/);
    if (convTasksMatch) {
      const conv = db
        .prepare('SELECT id, owner_id FROM conversations WHERE id = ?')
        .get(convTasksMatch[1]);
      if (!conv || conv.owner_id !== session.user_id) {
        fail(res, 404, 'not_found', 'Conversation not found');
        return;
      }
      const fullMode = (env.ME_UPSTREAM_MODE ?? 'core').trim().toLowerCase() === 'full';
      if (method === 'GET') {
        // FULL primary reads the authoritative upstream roster; legacy home
        // rows stay available via their explicit task ids below.
        if (fullMode) {
          try {
            const out = await forwardNative({ db, session, pathname: '/api/channels/', search: url.search ?? '', method: 'GET', env, fetchImpl: upstreamFetch });
            let body = null;
            try { body = out.json(); } catch { body = null; }
            if (!out.ok) {
              fail(res, out.status, 'upstream_refused', 'Upstream channel roster refused');
              return;
            }
            const channels = body?.channels ?? [];
            send(res, 200, {
              tasks: channels.map((c) => ({
                id: c.id, title: c.name ?? 'Untitled', active: c.active ?? null,
                execution: 'full-upstream', upstream: { channel: c },
              })),
              execution: 'full-upstream',
            });
          } catch (error) {
            fail(res, error.status ?? 502, error.code ?? 'upstream_unavailable', String(error.message ?? 'Upstream unavailable').slice(0, 500));
          }
          return;
        }
        const tasks = await broker.listViews(session.user_id, conv.id);
        send(res, 200, { tasks });
        return;
      }
      if (method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          fail(res, error.status ?? 400, 'bad_request', error.message);
          return;
        }
        // FULL primary executes on the real upstream router/worker via the
        // native channel+message calls (no local runner, no second
        // scheduler). agentId is explicit: read proxied GET /api/agents.
        if (fullMode) {
          for (const key of ['model', 'workspace', 'run_id', 'user_id', 'conversation_id', 'conversationId']) {
            if (body && typeof body === 'object' && key in body) {
              fail(res, 400, 'bad_request', `Field is home-managed: ${key}`);
              return;
            }
          }
          try {
            const out = await submitToUpstream(db, {
              session, homeConversationId: conv.id, title: body?.title,
              request: body?.request, agentId: body?.agentId, env, fetchImpl: upstreamFetch,
            });
            send(res, 201, out.task);
          } catch (error) {
            const status = error.status ?? statusFor(error.code);
            fail(res, status, error.code ?? 'bad_request', String(error.message ?? 'submit failed').slice(0, 500));
          }
          return;
        }
        // The home selects model/workspace/identity. Client overrides are
        // rejected: model in particular never comes from the phone.
        if (body && typeof body === 'object' && 'model' in body) {
          fail(res, 400, 'model_override_denied', 'Model config is home-selected and cannot be set by clients');
          return;
        }
        for (const key of ['workspace', 'run_id', 'user_id', 'conversation_id', 'conversationId']) {
          if (body && typeof body === 'object' && key in body) {
            fail(res, 400, 'bad_request', `Field is home-managed: ${key}`);
            return;
          }
        }
        try {
          const task = await broker.submit({
            owner: session.user_id,
            conversation: conv,
            title: body?.title,
            request: body?.request,
            reqCaps: body?.capabilities,
            budgets: body?.budgets,
          });
          const view = await broker.taskView(session.user_id, task.id, { withProgress: false });
          send(res, 201, view);
        } catch (error) {
          fail(res, statusFor(error.code), error.code ?? 'bad_request', error.message);
        }
        return;
      }
    }

    const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskMatch) {
      const fullMode = (env.ME_UPSTREAM_MODE ?? 'core').trim().toLowerCase() === 'full';
      // FULL primary: the task IS the upstream channel (authoritative read).
      // Legacy home rows (broker ids) keep serving explicitly below.
      if (fullMode) {
        try {
          const out = await forwardNative({ db, session, pathname: `/api/channels/${encodeURIComponent(taskMatch[1])}`, method: 'GET', env, fetchImpl: upstreamFetch });
          if (out.status === 404) {
            const view = await broker.taskView(session.user_id, taskMatch[1], { withProgress: true });
            if (!view) {
              fail(res, 404, 'not_found', 'Task not found');
              return;
            }
            send(res, 200, view);
            return;
          }
          let body = null;
          try { body = out.json(); } catch { body = null; }
          if (!out.ok) {
            fail(res, out.status, 'upstream_refused', 'Upstream task refused');
            return;
          }
          const channel = body?.channel ?? body;
          send(res, 200, {
            id: channel?.id ?? taskMatch[1], title: channel?.name ?? 'Untitled',
            active: channel?.active ?? null, execution: 'full-upstream', upstream: { channel },
          });
        } catch (error) {
          fail(res, error.status ?? 502, error.code ?? 'upstream_unavailable', String(error.message ?? 'Upstream unavailable').slice(0, 500));
        }
        return;
      }
      const view = await broker.taskView(session.user_id, taskMatch[1], { withProgress: true });
      if (!view) {
        fail(res, 404, 'not_found', 'Task not found');
        return;
      }
      send(res, 200, view);
      return;
    }

    const cancelMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const out = await broker.cancel(session.user_id, cancelMatch[1]);
      if (!out.found) {
        fail(res, 404, 'not_found', 'Task not found');
        return;
      }
      if (out.conflict) {
        fail(res, 409, 'wrong_state', out.conflict);
        return;
      }
      send(res, 200, await broker.taskView(session.user_id, cancelMatch[1], { withProgress: false }));
      return;
    }

    const inputsMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/inputs$/);
    if (method === 'POST' && inputsMatch) {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        fail(res, error.status ?? 400, 'bad_request', error.message);
        return;
      }
      try {
        const out = await broker.answer(session.user_id, inputsMatch[1], body?.inputs);
        if (!out.found) {
          fail(res, 404, 'not_found', 'Task not found');
          return;
        }
        if (out.conflict) {
          fail(res, 409, 'wrong_state', out.conflict);
          return;
        }
        send(res, 200, await broker.taskView(session.user_id, inputsMatch[1], { withProgress: false }));
      } catch (error) {
        fail(res, statusFor(error.code), error.code ?? 'bad_request', error.message);
      }
      return;
    }

    const approvalsMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/approvals$/);
    if (method === 'POST' && approvalsMatch) {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        fail(res, error.status ?? 400, 'bad_request', error.message);
        return;
      }
      try {
        const out = await broker.decide(session.user_id, approvalsMatch[1], body?.approvals);
        if (!out.found) {
          fail(res, 404, 'not_found', 'Task not found');
          return;
        }
        if (out.conflict) {
          fail(res, 409, 'wrong_state', out.conflict);
          return;
        }
        send(res, 200, await broker.taskView(session.user_id, approvalsMatch[1], { withProgress: false }));
      } catch (error) {
        fail(res, statusFor(error.code), error.code ?? 'bad_request', error.message);
      }
      return;
    }

    const taskArtsMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/artifacts$/);
    if (method === 'GET' && taskArtsMatch) {
      const list = await broker.artifactList(session.user_id, taskArtsMatch[1]);
      if (!list) {
        fail(res, 404, 'not_found', 'Task not found');
        return;
      }
      send(res, 200, { artifacts: list });
      return;
    }

    const artContentMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
    if (method === 'GET' && artContentMatch) {
      const task = await broker.store.get(session.user_id, 'tasks', artContentMatch[1]);
      if (!task) {
        fail(res, 404, 'not_found', 'Task not found');
        return;
      }
      const row = await broker.artifactContent(session.user_id, artContentMatch[2]);
      if (!row || row.task_id !== artContentMatch[1]) {
        fail(res, 404, 'not_found', 'Artifact not found');
        return;
      }
      // Bytes only: never expose home filesystem paths through this route.
      const data = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
      const filename = String(row.name).split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        'content-disposition': `attachment; filename="${filename}"`,
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
      return;
    }

    const msgsMatch = pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
    if (msgsMatch) {
      const conv = db
        .prepare('SELECT id, owner_id FROM conversations WHERE id = ?')
        .get(msgsMatch[1]);
      if (!conv || conv.owner_id !== session.user_id) {
        fail(res, 404, 'not_found', 'Conversation not found');
        return;
      }
      if (method === 'GET') {
        const rows = db
          .prepare('SELECT id, conversation_id, author_user_id, author_device_id, role, body, request_key, task_id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, id')
          .all(conv.id);
        send(res, 200, { messages: rows.map((m) => ({ ...m, duplicate: false })) });
        return;
      }
      if (method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          fail(res, error.status ?? 400, 'bad_request', error.message);
          return;
        }
        // task_id and author_* are home-managed: the public POST only ever
        // creates caller-authored user messages.
        for (const key of ['task_id', 'author_user_id', 'author_device_id']) {
          if (body && typeof body === 'object' && key in body) {
            fail(res, 400, 'bad_request', `Field is home-managed: ${key}`);
            return;
          }
        }
        const out = storeMessage(db, conv, session, body);
        if (out.ok) send(res, out.status, out.record);
        else fail(res, out.status, out.code, out.message);
        return;
      }
    }

    fail(res, 404, 'not_found', 'Unknown route');
  }

  function log(req, res) {
    // Redaction rule: method + path + status only. Never log headers/body.
    process.stderr.write(`${req.method} ${new URL(req.url, 'http://localhost').pathname} -> ${res.statusCode}\n`);
  }

  return {
    installationId,
    db,
    broker,
    notifications,
    coordinator,
    async start({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
      // Live evidence only applies to FULL; legacy never probes upstream.
      // liveKick=false keeps the construction seed only (tests); production
      // always kicks immediately so a restart re-verifies without waiting.
      if ((env.ME_UPSTREAM_MODE ?? 'core').trim().toLowerCase() === 'full') {
        try { liveTracker.start({ kick: liveKick }); } catch { /* liveness is auxiliary */ }
      }
      await broker.start();
      // Coordinator initial heartbeat is async + nonblocking by design.
      try { await coordinator.start(); } catch { /* coordinator never fails start */ }
      http = createServer((req, res) => {
        res.on('finish', () => log(req, res));
        handle(req, res).catch((error) => {
          if (!res.headersSent) fail(res, 500, 'internal', 'Internal error');
        });
      });
      await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, resolve);
      });
      return { host, port: http.address().port, installationId };
    },
    async stop() {
      // Bounded shutdown: stop accepting, drain idle keep-alive sockets, wait
      // briefly for in-flight requests, then force-close the rest so a hung
      // peer can never wedge shutdown. Broker stop (bounded internally) runs
      // while the DB is still open; the DB closes last.
      try { liveTracker.stop(); } catch { /* best effort */ }
      if (http) {
        const closing = http;
        http = null;
        try {
          closing.closeIdleConnections?.();
        } catch {
          /* older runtime without the API */
        }
        const drained = await withDeadline(
          new Promise((resolve) => closing.close(resolve)),
          5000,
        );
        if (drained.timedOut) {
          try {
            closing.closeAllConnections?.();
          } catch {
            /* best effort */
          }
          await withDeadline(new Promise((resolve) => closing.close(resolve)), 2000);
        }
      }
      try { await coordinator.stop(); } catch { /* best effort */ }
      await broker.stop();
      closeHomeDb({ db });
    },
  };
}

function statusFor(code) {
  if (code === 'model_not_configured' || code === 'runtime_not_configured' || code === 'upstream_not_configured') return 503;
  if (code === 'unauthorized') return 401;
  if (code === 'not_found' || code === 'upstream_not_linked') return 404;
  if (code === 'delegation_conflict') return 409;
  if (code === 'delegation_denied' || code === 'capability_denied') return 400;
  return 400;
}
