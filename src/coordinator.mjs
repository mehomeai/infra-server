// H8 home coordinator (home-coordinator-v1): actual home<->backend coordination.
// The home consumes a private credentials file written by Setup (S7) and
// heartbeats the hosted backend with its HomeToken. Disabled by default:
// no outbound network unless HOME_COORDINATOR_CREDENTIALS_FILE points at a
// valid private file. Private home/tasks/pairing keep working regardless.
//
// Source reality: heartbeat route + HomeToken auth + activation file shape
// come from backend-server/docs/home-activation-v1.md (B7) and
// docs/backend-api-v1.md (B4). This module does NOT invent crypto, server
// pinning, or phone rebind policy.

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const COORDINATOR_PROTOCOL = 'home-coordinator-v1';
export const COORDINATOR_PROTOCOL_VERSION = 'home-api-v1';

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 600_000;
export const DEFAULT_TIMEOUT_MS = 8_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_CREDENTIALS_BYTES = 16 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

const HOME_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const INSTALLATION_ID_RE = /^[\x20-\x7E]{1,128}$/;
const HOME_TOKEN_RE = /^me_home_[A-Za-z0-9_-]{32,128}$/;
const EXPECTED_KEYS = new Set([
  'protocol',
  'backend_url',
  'home_id',
  'installation_id',
  'home_token',
  'endpoint_hint',
  'protocol_version',
]);

function isLoopbackHostname(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function hasUserinfo(url) {
  return Boolean(url.username) || Boolean(url.password);
}

// Strict URL gate shared by backend_url and endpoint_hint: public https://,
// or plain http:// loopback ONLY with explicit dev/test opt-in. Never fetch
// or log the raw value on failure (generic codes only).
function assertHttpsOrLoopbackHttp(url, allowHttpLoopback, kind) {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && allowHttpLoopback && isLoopbackHostname(url.hostname)) return;
  throw coordinatorError(kind === 'backend' ? 'invalid_backend_url' : 'invalid_endpoint_hint');
}

export function coordinatorError(code) {
  return Object.assign(new Error(code), { code });
}

function parsePositiveInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw coordinatorError('invalid_coordinator_env');
  }
  return n;
}

export function resolveCoordinatorEnv(env = process.env) {
  const file = env.HOME_COORDINATOR_CREDENTIALS_FILE;
  if (file === undefined || file === null || String(file).trim() === '') {
    return { enabled: false };
  }
  return {
    enabled: true,
    credentialsFile: String(file),
    intervalMs: parsePositiveInt(env.HOME_COORDINATOR_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    timeoutMs: parsePositiveInt(env.HOME_COORDINATOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    allowHttpLoopback: env.HOME_COORDINATOR_ALLOW_HTTP_LOOPBACK === '1'
      || String(env.HOME_COORDINATOR_ALLOW_HTTP_LOOPBACK ?? '').toLowerCase() === 'true',
  };
}

function validateBackendUrl(raw, allowHttpLoopback) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) {
    throw coordinatorError('invalid_backend_url');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coordinatorError('invalid_backend_url');
  }
  if (!url.hostname) throw coordinatorError('invalid_backend_url');
  if (hasUserinfo(url)) throw coordinatorError('invalid_backend_url');
  if (url.search || url.hash) throw coordinatorError('invalid_backend_url');
  assertHttpsOrLoopbackHttp(url, allowHttpLoopback, 'backend');
  return url;
}

function validateEndpointHint(raw, allowHttpLoopback) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) {
    throw coordinatorError('invalid_endpoint_hint');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw coordinatorError('invalid_endpoint_hint');
  }
  if (!url.hostname) throw coordinatorError('invalid_endpoint_hint');
  if (hasUserinfo(url)) throw coordinatorError('invalid_endpoint_hint');
  if (url.search || url.hash) throw coordinatorError('invalid_endpoint_hint');
  assertHttpsOrLoopbackHttp(url, allowHttpLoopback, 'endpoint');
  return raw;
}

// Load + validate the private credentials file. Throws generic coded errors
// only: never echo parsed values, secrets, or file contents.
export function loadCoordinatorCredentials(credentialsFile, { expectedInstallationId, allowHttpLoopback = false } = {}) {
  if (typeof credentialsFile !== 'string' || credentialsFile.length === 0) {
    throw coordinatorError('missing_credentials_file');
  }
  if (!isAbsolute(credentialsFile)) throw coordinatorError('invalid_credentials_path');
  let lst;
  try {
    lst = lstatSync(credentialsFile);
  } catch {
    throw coordinatorError('credentials_unreadable');
  }
  // No final symlink: the secret file must be a directly-owned regular file.
  if (lst.isSymbolicLink()) throw coordinatorError('invalid_credentials_file');
  let st;
  try {
    st = statSync(credentialsFile);
  } catch {
    throw coordinatorError('credentials_unreadable');
  }
  if (!st.isFile()) throw coordinatorError('invalid_credentials_file');
  if (st.size <= 0 || st.size > MAX_CREDENTIALS_BYTES) throw coordinatorError('invalid_credentials_file');
  // Owner-only: no group/other permissions (0600-style).
  if ((st.mode & 0o077) !== 0) throw coordinatorError('invalid_credentials_permissions');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(credentialsFile, 'utf8'));
  } catch {
    throw coordinatorError('invalid_credentials_format');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw coordinatorError('invalid_credentials_format');
  }
  for (const key of Object.keys(parsed)) {
    if (!EXPECTED_KEYS.has(key)) throw coordinatorError('invalid_credentials_format');
  }
  for (const key of EXPECTED_KEYS) {
    if (typeof parsed[key] !== 'string') throw coordinatorError('invalid_credentials_format');
  }
  if (parsed.protocol !== COORDINATOR_PROTOCOL) throw coordinatorError('invalid_credentials_format');
  if (parsed.protocol_version !== COORDINATOR_PROTOCOL_VERSION) throw coordinatorError('invalid_credentials_format');
  if (!HOME_ID_RE.test(parsed.home_id)) throw coordinatorError('invalid_credentials_format');
  if (!INSTALLATION_ID_RE.test(parsed.installation_id)) throw coordinatorError('invalid_credentials_format');
  if (!HOME_TOKEN_RE.test(parsed.home_token)) throw coordinatorError('invalid_credentials_format');
  validateBackendUrl(parsed.backend_url, allowHttpLoopback);
  validateEndpointHint(parsed.endpoint_hint, allowHttpLoopback);
  if (expectedInstallationId && parsed.installation_id !== expectedInstallationId) {
    throw coordinatorError('wrong_home');
  }
  return {
    protocol: parsed.protocol,
    backendUrl: parsed.backend_url,
    homeId: parsed.home_id,
    installationId: parsed.installation_id,
    homeToken: parsed.home_token,
    endpointHint: parsed.endpoint_hint,
    protocolVersion: parsed.protocol_version,
  };
}

export function redactHomeId(homeId) {
  const s = String(homeId ?? '');
  if (!s) return null;
  if (s.length <= 8) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

function heartbeatUrl(backendUrl, homeId) {
  const base = String(backendUrl).replace(/\/+$/, '');
  return `${base}/v1/homes/${encodeURIComponent(homeId)}/heartbeat`;
}

async function readBoundedBody(res) {
  // Bounded response: abort oversized payloads before they bloat the home.
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw coordinatorError('response_too_large');
  }
  return text;
}

export function createCoordinator({ installationId, env = process.env, fetchImpl = null, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const resolved = resolveCoordinatorEnv(env);
  const fetchFn = fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;
  const state = {
    enabled: resolved.enabled,
    configured: false,
    configError: resolved.enabled ? 'not_loaded' : null,
    suspended: false,
    credentials: null,
    credentialsMtimeMs: 0,
    generation: 0,
    lastHeartbeat: null,
    lastCheckAt: null,
    nextAttemptAt: null,
    consecutiveFailures: 0,
    running: false,
    stopped: false,
  };
  let timer = null;
  let inflight = null;
  let inflightController = null;

  function clearTimer() {
    if (timer !== null) {
      try { clearTimeoutFn(timer); } catch { /* ignore */ }
      timer = null;
    }
  }

  function schedule(delayMs) {
    clearTimer();
    if (state.stopped) return;
    const jitter = Math.floor(Math.random() * 1000);
    const bounded = Math.min(Math.max(1000, delayMs + jitter), MAX_BACKOFF_MS + 5000);
    state.nextAttemptAt = Date.now() + bounded;
    timer = setTimeoutFn(() => {
      timer = null;
      void tick();
    }, bounded);
    // Don't hold the process open for coordination alone.
    timer?.unref?.();
  }

  function refreshCredentials() {
    if (!resolved.enabled) return false;
    let mtimeMs = 0;
    try {
      const st = statSync(resolved.credentialsFile);
      mtimeMs = Number(st.mtimeMs ?? 0);
    } catch {
      // File deleted (e.g. after full restore): reactivation needed, no network.
      if (state.credentials !== null || state.configError !== 'credentials_unreadable') {
        state.generation += 1;
      }
      state.credentials = null;
      state.configured = true;
      state.configError = 'credentials_unreadable';
      state.credentialsMtimeMs = 0;
      return false;
    }
    if (state.credentials && mtimeMs === state.credentialsMtimeMs) return true;
    let creds;
    try {
      creds = loadCoordinatorCredentials(resolved.credentialsFile, {
        expectedInstallationId: installationId,
        allowHttpLoopback: resolved.allowHttpLoopback,
      });
    } catch (error) {
      if (state.configError !== error?.code || state.credentials !== null) {
        state.generation += 1;
      }
      state.credentials = null;
      state.configured = true;
      state.configError = error?.code ?? 'invalid_credentials_format';
      state.credentialsMtimeMs = mtimeMs;
      // A fixed file clears suspension: rotations recover without restart.
      return false;
    }
    const rotated = !state.credentials || state.credentials.homeToken !== creds.homeToken
      || state.credentials.backendUrl !== creds.backendUrl
      || state.credentials.homeId !== creds.homeId;
    state.credentials = creds;
    state.credentialsMtimeMs = mtimeMs;
    state.configured = true;
    state.configError = null;
    state.generation += 1;
    if (rotated) {
      state.suspended = false;
      state.consecutiveFailures = 0;
    }
    return true;
  }

  async function doHeartbeatOnce({ reason = 'manual' } = {}) {
    void reason;
    if (!resolved.enabled) return { skipped: 'disabled' };
    const ok = refreshCredentials();
    if (!ok || !state.credentials) {
      state.lastCheckAt = Date.now();
      return { skipped: 'config_error', code: state.configError };
    }
    if (state.suspended) {
      state.lastCheckAt = Date.now();
      return { skipped: 'suspended' };
    }
    if (!fetchFn) {
      state.lastCheckAt = Date.now();
      return { skipped: 'no_fetch' };
    }
    const gen = state.generation;
    const creds = state.credentials;
    const controller = new AbortController();
    inflightController = controller;
    const timeoutMs = resolved.timeoutMs;
    const timeout = setTimeoutFn(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, timeoutMs);
    timeout?.unref?.();
    const attempt = (async () => {
      let res;
      try {
        res = await fetchFn(heartbeatUrl(creds.backendUrl, creds.homeId), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${creds.homeToken}`,
          },
          body: JSON.stringify({
            status: 'online',
            endpointHint: creds.endpointHint,
            installationId: creds.installationId,
          }),
          redirect: 'error',
          signal: controller.signal,
        });
      } finally {
        try { clearTimeoutFn(timeout); } catch { /* ignore */ }
      }
      // Final origin/status checks: only the configured origin, no redirects
      // (redirect:'error' rejects them), no credential forwarding.
      if (gen !== state.generation) return { skipped: 'stale_generation' };
      if (res.status === 401 || res.status === 403) {
        state.suspended = true;
        state.consecutiveFailures += 1;
        state.lastCheckAt = Date.now();
        return { ok: false, suspended: true, status: res.status };
      }
      if (res.status !== 200) {
        state.consecutiveFailures += 1;
        state.lastCheckAt = Date.now();
        return { ok: false, status: res.status };
      }
      let text;
      try {
        text = await readBoundedBody(res);
      } catch {
        state.consecutiveFailures += 1;
        state.lastCheckAt = Date.now();
        return { ok: false, status: 'bad_body' };
      }
      if (gen !== state.generation) return { skipped: 'stale_generation' };
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        state.consecutiveFailures += 1;
        state.lastCheckAt = Date.now();
        return { ok: false, status: 'bad_body' };
      }
      // Backend response NEVER reconfigures private home URL/model/auth.
      // Record liveness observations only.
      state.consecutiveFailures = 0;
      const now = Date.now();
      state.lastCheckAt = now;
      state.lastHeartbeat = {
        at: now,
        ok: true,
        lastSeenAt: typeof payload?.lastSeenAt === 'string' ? payload.lastSeenAt : null,
        lastStatus: typeof payload?.lastStatus === 'string' ? payload.lastStatus : null,
      };
      return { ok: true };
    })();
    inflight = attempt;
    try {
      return await attempt;
    } catch (error) {
      if (gen !== state.generation) return { skipped: 'stale_generation' };
      // Abort on stop vs transient backend-down: both reschedule, but stop
      // never retries. Transient down stays offline-rescheduled, never
      // pauses the agent.
      if (error?.name === 'AbortError' && state.stopped) {
        return { ok: false, status: 'aborted' };
      }
      state.consecutiveFailures += 1;
      state.lastCheckAt = Date.now();
      return { ok: false, status: 'network_error' };
    } finally {
      if (inflight === attempt) inflight = null;
      if (inflightController === controller) inflightController = null;
    }
  }

  async function tick() {
    if (state.stopped) return;
    // Serialize: a slow backend never stacks concurrent heartbeats.
    if (inflight) {
      schedule(resolved.intervalMs);
      return;
    }
    await doHeartbeatOnce({ reason: 'tick' });
    if (state.stopped) return;
    // Suspended on auth: poll the file (fast enough to pick up rotation)
    // without touching the network.
    if (state.suspended || state.configError) {
      schedule(Math.min(resolved.intervalMs, 15_000));
      return;
    }
    const failures = state.consecutiveFailures;
    const backoff = failures === 0
      ? resolved.intervalMs
      : Math.min(MAX_BACKOFF_MS, resolved.intervalMs * (2 ** Math.min(failures, 4)));
    schedule(backoff);
  }

  return {
    state,
    config: resolved,
    async start() {
      if (!resolved.enabled) return { enabled: false };
      if (state.running) return { enabled: true };
      state.running = true;
      state.stopped = false;
      refreshCredentials();
      // Initial heartbeat is async + nonblocking: never hold up home start.
      schedule(1500);
      return { enabled: true };
    },
    async stop() {
      state.stopped = true;
      clearTimer();
      try { inflightController?.abort(); } catch { /* ignore */ }
      if (inflight) {
        // Bounded drain: no orphan fetches wedge shutdown.
        await Promise.race([
          inflight.catch(() => null),
          new Promise((resolve) => {
            const t = setTimeoutFn(resolve, 2000);
            t?.unref?.();
          }),
        ]);
      }
      state.running = false;
      return { stopped: true };
    },
    heartbeatOnce(opts) {
      return doHeartbeatOnce(opts);
    },
    refreshCredentials,
    getStatus() {
      // Redacted by construction: never token/prefix/raw errors/account claims.
      return {
        configured: state.configured,
        enabled: state.enabled,
        status: !state.enabled ? 'disabled'
          : state.configError ? 'config_error'
          : state.suspended ? 'suspended'
          : state.lastHeartbeat?.ok ? 'online'
          : state.consecutiveFailures > 0 ? 'offline' : 'unknown',
        homeId: state.credentials ? redactHomeId(state.credentials.homeId) : null,
        lastHeartbeat: state.lastHeartbeat ? { ...state.lastHeartbeat } : null,
        lastCheckAt: state.lastCheckAt,
        nextAttemptAt: state.nextAttemptAt,
        suspended: state.suspended,
        configError: state.configError && state.configError !== 'not_loaded' ? 'configuration_error' : state.configError,
      };
    },
  };
}
