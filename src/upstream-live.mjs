// In-home live-evidence tracker (FULL mode) — two-tier readiness
// handshake (OPEN #4, docs/readiness-handshake-design.md).
//
// The home server must not call phone setup-needed forever after install,
// nor trust a stale flag. This tracker keeps IN-MEMORY trusted evidence on
// a bounded loop; the phone capability path (/healthz, /v1/me) and
// /readyz/full never await the network — they read the snapshot
// synchronously.
//
// Two tiers, one pipeline:
// - LIGHT tier (120 s, unchanged): upstream /health, REQUIRED
//   /api/capabilities, authenticated native GET /api/agents with a FRESH
//   single-use assertion. No Postgres driver, no SDK, no model calls.
// - FULL tier (600 s): the doctor's probe set via upstream-probes.mjs —
//   fleet admin + user-role gate, model-served proof including the
//   container-namespace Ollama proof. `live` is published ONLY when both
//   tiers hold fresh passing evidence: a stack that merely answers
//   /health can never flap the phone back to "ready", and a light-tier
//   failure drops readiness immediately.
//
// Invalidation bus: invalidate(reason) drops published evidence to
// not-live SYNCHRONOUSLY and bumps a generation counter; a probe that was
// in flight when the invalidation landed has its result DISCARDED, and a
// replacement probe is kicked. Triggers: TTL expiry (per-tier, enforced
// in get()), any probe failure, a doctor-cache file change written by
// anyone but this tracker (a fresh CLI doctor verdict supersedes tracker
// evidence in both directions), and a config fingerprint change (sorted
// REQUIRED_ENV values + BOT_MODEL/OPENAI_BASE_URL, recomputed each cycle).
//
// Cache: the on-disk doctor cache stays the cross-restart seed and keeps
// its payload contract (protocol/state/mode/pin/at/ttlMs, byte-capped,
// atomic tmp+rename); tracker writes add only the additive fields
// tier + generation, which existing readers ignore.

import { createHash } from 'node:crypto';
import {
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
  renameSync as nodeRenameSync,
} from 'node:fs';
import { signHomeAssertion, ASSERTION_HEADER } from './upstream-proxy.mjs';
import { boundedJson, readLiveEvidence, DOCTOR_CACHE_TTL_MS, DOCTOR_CACHE_PROTOCOL, DOCTOR_CACHE_MAX_BYTES } from './upstream-doctor.mjs';
import { UPSTREAM_PIN } from './upstream-config.mjs';
import { probeFullEvidence } from './upstream-probes.mjs';

export const LIVE_PROBE_TIMEOUT_MS = 10_000;
export const LIVE_CACHE_MAX_BYTES = 4096;
export const LIVE_FULL_INTERVAL_MS = 600_000;
export const LIVE_FULL_TTL_MS = 900_000;

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

// Fingerprint of the config the evidence was proven against. A changed
// fingerprint means the old evidence describes a different stack.
export function configFingerprint(env = process.env) {
  const keys = [...REQUIRED_ENV, 'BOT_MODEL', 'OPENAI_BASE_URL'].sort();
  const hash = createHash('sha256');
  for (const k of keys) hash.update(`${k}=${String(env[k] ?? '')}\n`);
  return hash.digest('hex');
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
  fullIntervalMs = LIVE_FULL_INTERVAL_MS,
  fullTtlMs = LIVE_FULL_TTL_MS,
  now = Date.now,
  cachePath = null,
  fs = null,
  onChange = null,
  probeFull = null,
} = {}) {
  const runFullProbe = probeFull ?? ((opts) => probeFullEvidence({ ...opts, configValid: liveConfig }));
  // Per-tier evidence. `at` is the evidence time; `freshMs` is the TTL the
  // CURRENT evidence is judged against (a cache seed carries the cache's
  // own ttlMs until the tier's first own probe replaces it).
  let light = { live: false, reason: 'boot', at: 0 };
  let full = { live: false, reason: 'boot', at: 0, checks: null };
  let lightFreshMs = ttlMs;
  let fullFreshMs = fullTtlMs;
  let generation = 0;
  let fingerprint = configFingerprint(env);
  let timer = null;
  let cycleInflight = null;
  let stopped = false;
  let lastProbeAt = 0;
  let lastFullProbeAt = 0;
  let reprobeNeeded = false;

  const readCacheRaw = () => {
    try {
      const raw = fs?.readFileSync ? fs.readFileSync(cachePath, 'utf8') : nodeReadFileSync(cachePath, 'utf8');
      return typeof raw === 'string' ? raw : null;
    } catch {
      return null;
    }
  };
  const sigOf = (raw) => (raw == null ? null : createHash('sha256').update(raw).digest('hex'));
  let cacheSig = null;
  let ownCacheSig = null;

  // Seed from the on-disk cache (best effort): a fresh READY doctor verdict
  // proves BOTH tiers at its own `at` (the doctor's probe set is a superset
  // of the light tier) under the cache's own TTL, until own probes land.
  if (cachePath) {
    const raw = readCacheRaw();
    cacheSig = sigOf(raw);
    try {
      const file = readLiveEvidence(cachePath, { at: now(), fs });
      if (file.live) {
        light = { live: true, reason: 'cache', at: file.at };
        full = { live: true, reason: 'cache', at: file.at, checks: null };
        lightFreshMs = file.ttlMs;
        fullFreshMs = file.ttlMs;
      } else if (file.reason === 'stale') {
        light = { live: false, reason: 'stale', at: now() };
        full = { live: false, reason: 'stale', at: now(), checks: null };
      }
    } catch { /* boot unproven */ }
  }

  function snapshot() {
    const t = now();
    const lightStale = light.live && t - light.at > lightFreshMs;
    const fullStale = full.live && t - full.at > fullFreshMs;
    const at = Math.min(light.at || t, full.at || t);
    const evidence = {
      tier: full.live ? 'full' : 'light',
      at: full.at || light.at || t,
      namespace: full.checks?.model?.namespace ?? null,
    };
    if (light.live && full.live && !lightStale && !fullStale) {
      return { live: true, at, evidence, checks: full.checks };
    }
    let reason;
    if ((light.live && lightStale) || (full.live && fullStale)) reason = 'stale';
    else if (!full.live && full.at > 0 && full.reason !== 'boot') reason = full.reason;
    else if (!light.live && light.at > 0 && light.reason !== 'boot') reason = light.reason;
    else reason = full.reason ?? light.reason ?? 'boot';
    return { live: false, reason, at, evidence, checks: full.checks };
  }

  let lastPublished = snapshot();

  function writeCache() {
    if (!cachePath) return;
    const payload = {
      protocol: DOCTOR_CACHE_PROTOCOL,
      state: 'READY',
      mode: 'full',
      pin: UPSTREAM_PIN,
      at: now(),
      ttlMs,
      tier: 'full',
      generation,
    };
    const data = JSON.stringify(payload);
    if (data.length > DOCTOR_CACHE_MAX_BYTES) return;
    try {
      // Atomic tmp + rename (doctor's writer shape); plain write only when
      // the injected seam provides no rename.
      const writeFileSync = fs?.writeFileSync ?? nodeWriteFileSync;
      const renameSync = fs?.renameSync ?? nodeRenameSync;
      if (fs && !fs.renameSync) {
        writeFileSync(cachePath, data);
      } else {
        writeFileSync(`${cachePath}.tmp`, data);
        renameSync(`${cachePath}.tmp`, cachePath);
      }
      cacheSig = sigOf(data);
      ownCacheSig = cacheSig;
    } catch { /* cache is auxiliary; memory is authoritative */ }
  }

  function publish() {
    const next = snapshot();
    const changed = next.live !== lastPublished.live || next.reason !== lastPublished.reason;
    lastPublished = next;
    if (next.live) writeCache();
    if (changed && typeof onChange === 'function') {
      try { onChange(next); } catch { /* observer must not break the loop */ }
    }
    return next;
  }

  function invalidate(reason) {
    generation++;
    const stamp = `invalidated:${reason}`;
    light = { live: false, reason: stamp, at: now() };
    full = { live: false, reason: stamp, at: now(), checks: full.checks };
    const out = publish();
    if (!stopped) {
      if (cycleInflight) reprobeNeeded = true;
      else queueMicrotask(() => { refresh().catch(() => {}); });
    }
    return out;
  }

  // Trigger (d): config fingerprint change invalidates before probing.
  function checkFingerprint() {
    const fp = configFingerprint(env);
    if (fp !== fingerprint) {
      fingerprint = fp;
      invalidate('config');
    }
  }

  // Trigger (c): an external doctor-cache change (e.g. a CLI
  // `upstream-doctor` run) supersedes tracker evidence in both directions.
  function checkCacheDrift() {
    if (!cachePath) return;
    const raw = readCacheRaw();
    const sig = sigOf(raw);
    if (sig === cacheSig) return;
    cacheSig = sig;
    if (sig !== null && sig === ownCacheSig) return; // our own write, already reflected
    let file;
    try {
      file = readLiveEvidence(cachePath, { at: now(), fs });
    } catch {
      file = { live: false, reason: 'missing' };
    }
    if (file.live) {
      generation++;
      light = { live: true, reason: 'doctor-cache', at: file.at };
      full = { live: true, reason: 'doctor-cache', at: file.at, checks: full.checks };
      lightFreshMs = file.ttlMs;
      fullFreshMs = file.ttlMs;
      publish();
    } else {
      invalidate('doctor-cache');
    }
  }

  function fullDue() {
    if (!full.live) return true; // no passing full evidence: (re)prove before publishing live
    return now() - lastFullProbeAt >= fullIntervalMs;
  }

  async function refresh() {
    if (stopped) return snapshot();
    if (cycleInflight) return cycleInflight; // singleflight: one cycle at a time
    cycleInflight = (async () => {
      checkFingerprint();
      checkCacheDrift();
      const gen = generation;
      lastProbeAt = now();
      const lightVerdict = await probeLiveEvidence({ env, fetchImpl });
      if (gen === generation && !stopped) {
        light = lightVerdict.live
          ? { live: true, at: now() }
          : { live: false, reason: lightVerdict.reason, at: now() };
        lightFreshMs = ttlMs;
        publish();
      }
      // Full tier runs after the light tier in the same cycle — the two
      // tiers never probe concurrently (full supersedes; light results
      // coalesce into the full run's cycle).
      if (fullDue() && !stopped) {
        lastFullProbeAt = now();
        let fullVerdict;
        try {
          fullVerdict = await runFullProbe({ env, fetchImpl });
        } catch (error) {
          fullVerdict = { live: false, reason: 'unreachable', detail: error.message, checks: null };
        }
        if (gen === generation && !stopped) {
          full = fullVerdict.live
            ? { live: true, at: now(), checks: fullVerdict.checks ?? null }
            : { live: false, reason: fullVerdict.reason ?? 'unreachable', at: now(), checks: fullVerdict.checks ?? null };
          fullFreshMs = fullTtlMs;
          publish();
        }
      }
      return snapshot();
    })();
    try {
      return await cycleInflight;
    } finally {
      cycleInflight = null;
      if (reprobeNeeded && !stopped) {
        reprobeNeeded = false;
        queueMicrotask(() => { refresh().catch(() => {}); });
      }
    }
  }

  function get() {
    return snapshot();
  }

  // Synchronous full-tier view for /readyz/full: ready only when the
  // published (two-tier) evidence is live; checks are the last full
  // probe's evidence (kept on failure for the 503 body).
  function getFull() {
    const snap = snapshot();
    const checks = full.checks ?? {
      nativeAuth: { probed: false },
      fleet: null,
      model: { selectedServed: false, namespace: null },
      intelligence: { probed: false, source: 'doctor' },
    };
    return {
      ready: snap.live,
      at: snap.at,
      ...(snap.live ? {} : { reason: snap.reason ?? 'not-ready' }),
      checks,
    };
  }

  return {
    get,
    getFull,
    refresh,
    invalidate,
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
    get lastFullProbeAt() { return lastFullProbeAt; },
    get generation() { return generation; },
  };
}
