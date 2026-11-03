// In-home bounded live-evidence tracker (FULL mode).
//
// The home server must not call phone setup-needed forever after install,
// nor trust a stale flag. This tracker keeps IN-MEMORY trusted evidence,
// refreshed on a bounded loop with singleflight (one probe at a time), and
// falls back to the bounded on-disk cache only across restarts. The phone
// capability path (/healthz, /v1/me) never awaits the network: it reads the
// in-memory snapshot synchronously.
//
// Refresh probe (lightweight, bounded, read-only): upstream /health,
// REQUIRED /api/capabilities, authenticated native GET /api/agents with a
// FRESH single-use assertion (replay-safe). No Postgres driver, no SDK, no
// model calls on this path — those belong to the full doctor run.
// Config loss (missing env) or source failure immediately marks not-live;
// TTL expiry does the same. Cache file writes are atomic (tmp + rename)
// and byte-capped; reads are capped too.

import { signHomeAssertion, ASSERTION_HEADER } from './upstream-proxy.mjs';
import { boundedJson, readLiveEvidence, writeDoctorCache, DOCTOR_CACHE_TTL_MS } from './upstream-doctor.mjs';

export const LIVE_PROBE_TIMEOUT_MS = 10_000;
export const LIVE_CACHE_MAX_BYTES = 4096;

const REQUIRED_ENV = [
  'UPSTREAM_SERVER_URL', 'DATABASE_URL', 'KEY_ENCRYPTION_KEY',
  'ME_HOME_BRIDGE_SECRET', 'INTELLIGENCE_API_URL',
  'INTELLIGENCE_GATEWAY_WS_URL', 'CPK_INTELLIGENCE_API_KEY',
  'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'INITIAL_ADMIN_EMAILS',
  'COMPUTER_SUPERVISOR_URL', 'SUPERVISOR_TOKEN', 'COMPUTER_TOKEN',
];

export function liveConfig(env = process.env) {
  const missing = [];
  for (const k of REQUIRED_ENV) {
    const v = env[k] ?? (k === 'UPSTREAM_SERVER_URL' ? env.ME_UPSTREAM_SERVER_URL : null);
    if (!v || !String(v).trim()) missing.push(k);
  }
  return { valid: missing.length === 0, missing };
}

function serverBase(env) {
  const base = String(env.UPSTREAM_SERVER_URL ?? env.ME_UPSTREAM_SERVER_URL ?? 'http://127.0.0.1:3001').trim().replace(/\/$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base) && !base.startsWith('http://upstream:')) {
    throw new Error('UPSTREAM_SERVER_URL must be a private loopback/compose address');
  }
  return base;
}

// One lightweight pass. Returns {live:true} or {live:false, reason}.
// Never throws for network/untrusted input (caller records the reason).
export async function probeLiveEvidence({ env = process.env, fetchImpl = fetch, timeoutMs = LIVE_PROBE_TIMEOUT_MS } = {}) {
  const cfg = liveConfig(env);
  if (!cfg.valid) return { live: false, reason: 'config', missing: cfg.missing };
  let base;
  try {
    base = serverBase(env);
  } catch (error) {
    return { live: false, reason: 'config', detail: error.message };
  }
  const noRedirect = (url, init = {}) => fetchImpl(url, { ...init, redirect: 'manual' });
  try {
    const health = await noRedirect(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const healthBody = await boundedJson(health).catch(() => null);
    if (!health.ok || healthBody?.status !== 'ok') return { live: false, reason: 'unreachable' };
    const caps = await noRedirect(`${base}/api/capabilities`, { signal: AbortSignal.timeout(timeoutMs) });
    const capsBody = await boundedJson(caps).catch(() => null);
    if (!caps.ok || capsBody?.mode == null || capsBody?.durableHistory == null) {
      return { live: false, reason: 'drift' };
    }
    const assertion = signHomeAssertion({
      upstreamUserId: 'me-live-probe', role: 'user', bridgeSecret: env.ME_HOME_BRIDGE_SECRET,
    });
    const agents = await noRedirect(`${base}/api/agents`, {
      headers: { [ASSERTION_HEADER]: assertion },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (agents.status === 401 || agents.status === 403) return { live: false, reason: 'auth' };
    const agentsBody = await boundedJson(agents).catch(() => null);
    if (!agents.ok || !Array.isArray(agentsBody?.agents)) return { live: false, reason: 'drift' };
    return { live: true };
  } catch {
    return { live: false, reason: 'unreachable' };
  }
}

export function createLiveTracker({
  env = process.env,
  fetchImpl = fetch,
  intervalMs = 120_000,
  ttlMs = DOCTOR_CACHE_TTL_MS,
  now = Date.now,
  cachePath = null,
  fs = null,
  onChange = null,
} = {}) {
  let current = { live: false, reason: 'boot', at: now() };
  // Seed from the on-disk cache (best effort) so the first request after a
  // restart reflects the last evidence until the first refresh completes.
  if (cachePath) {
    try {
      const file = readLiveEvidence(cachePath, { at: now(), fs });
      current = file.live
        ? { live: true, at: file.at, reason: 'cache' }
        : { live: false, reason: file.reason, at: now() };
    } catch { /* boot unproven */ }
  }
  let timer = null;
  let inflight = null;
  let stopped = false;
  let lastProbeAt = 0;

  const set = (next) => {
    const changed = next.live !== current.live || next.reason !== current.reason;
    current = { ...next, at: now() };
    if (cachePath && next.live) {
      try {
        writeDoctorCache(cachePath, { state: 'READY', checks: { mode: 'full' } }, { at: now(), ttlMs, fs });
      } catch { /* cache is auxiliary; memory is authoritative */ }
    }
    if (changed && typeof onChange === 'function') {
      try { onChange(current); } catch { /* observer must not break the loop */ }
    }
  };

  async function refresh() {
    if (stopped) return current;
    if (inflight) return inflight; // singleflight: concurrent ticks share one probe
    lastProbeAt = now();
    inflight = (async () => {
      const verdict = await probeLiveEvidence({ env, fetchImpl });
      if (!verdict.live) set({ live: false, reason: verdict.reason });
      else set({ live: true });
      return current;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function get() {
    // TTL is hard-bounded in memory too: stale evidence reads as not-live
    // even if the loop stalls.
    if (current.live && now() - current.at > ttlMs) {
      return { live: false, reason: 'stale' };
    }
    return current;
  }

  return {
    get,
    refresh,
    start({ kick = true } = {}) {
      if (timer) return;
      if (kick) refresh().catch(() => {});
      timer = setInterval(() => { refresh().catch(() => {}); }, Math.max(1000, intervalMs));
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    get lastProbeAt() { return lastProbeAt; },
  };
}
