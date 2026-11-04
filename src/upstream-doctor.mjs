// Independent upstream-platform-v1 stack doctor (FULL primary).
//
// Protocol: { protocol:'upstream-platform-v1', doctor_contract:'upstream-platform-v1/full.1', state:'READY'|'NEEDS_INPUT'|'FAILED', checks:{...} }
// The doctor_contract marker (also checks.doctor_contract) is the versioned
// full-evidence contract the setup supervisor requires; it is stamped on
// every report, and READY additionally requires every evidence field the
// checks below produce (see results/setup-doctor-contract.json).
// - READY (core): computer plane verified (pin, supervisor auth, per-user boundary).
// - READY (full): ALL required components verified: pin + server /health +
//   Postgres binding + supervisor auth/list + computer plane + self-hosted
//   Intelligence endpoint/key/entitlement + model authenticated + telemetry
//   opt-outs + protected datastore bindings. Licensed stack NEEDS_INPUT until
//   then, never READY from a health proxy or model remote-opt-in flag alone.
// - NEEDS_INPUT: missing operator input (tokens, OAuth, Intelligence key/license, model, hardware).
// - FAILED: misconfig, drift, unsafe SINGLE_USER, privacy violation.
// Must check MORE than health 200. FULL NEVER READY from empty health proxy.

import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync as readFileSyncCache, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSupervisorClient, checkUpstreamId } from './upstream-computer.mjs';
import { resolveUpstreamConfig, gateFullConfig, UPSTREAM_PIN, UPSTREAM_REPO } from './upstream-config.mjs';
import { resolveModelConfig, resolveNativeModelConfig } from './runtime-config.mjs';
import {
  probeUpstreamHealth, probeCapabilities, probeNativeAuth, probeModelServed,
  DOCTOR_PROBE_IDENTITY,
} from './upstream-probes.mjs';
import { readFile, stat } from 'node:fs/promises';

// Pinned SDK the production host uses for the authenticated entitlement
// read (same package the upstream server builds its Intelligence client
// from: server/src/intelligence-client.ts `new CopilotKitIntelligence`).
// Dynamic import: implementing the check needs no credentials and no local
// install; RUNNING it live needs the pinned package on the verifying host
// (INTELLIGENCE_SDK_ROOT with `npm i @copilotkit/runtime@1.83.0`, or the
// server image that already carries it) plus operator key/license.
// B's Python harness image does NOT provide the Node SDK on the host.
const INTELLIGENCE_SDK_SPECIFIERS = ['@copilotkit/runtime/v2', '@copilotkit/runtime'];
const INTELLIGENCE_SDK_PIN = '1.83.0';

// This module's own root (repo root = parent of src/), never process.cwd().
// The installer may invoke the CLI from a setup/data dir (/opt/me/infra/...)
// while the vendor manifest lives with the installed release.
function moduleRepoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function readLock(checkoutOrRepo = null) {
  const root = checkoutOrRepo ?? moduleRepoRoot();
  try {
    const raw = await readFile(join(root, 'vendor/openbot/upstream.json'), 'utf8');
    const lock = JSON.parse(raw);
    return lock;
  } catch {
    return null;
  }
}

// Versioned full-evidence contract marker (setup-doctor-contract /
// setup-wire-contract): the supervisor (C) accepts a live doctor report
// only when it carries this marker, top-level or as checks.doctor_contract,
// AND every required evidence field with verified values. Fail-closed
// until present, so the doctor stamps it on every report it produces.
export const DOCTOR_CONTRACT = 'upstream-platform-v1/full.1';

// Trusted patch manifest (F-owned): the ONLY authority for post-patch
// bytes. It lives with the patches in the installed release
// (vendor/openbot/patches/manifest.json, schema 1:
// {files: {path: {originalSha256, postSha256}}, unmodified: {path: sha256}},
// byte-verified by apply.sh; see patch-auth-v3). Loading is fail-closed:
// a missing, unreadable, malformed or tampered manifest is a verification
// failure, never a silent downgrade to structural-only checks.
export const PATCH_MANIFEST_PATH = 'vendor/openbot/patches/manifest.json';
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function loadPatchManifest(root) {
  const failLoad = (reason) => ({ ok: false, reason });
  let raw;
  try {
    raw = readFileSyncCache(join(root, PATCH_MANIFEST_PATH), 'utf8');
  } catch {
    return failLoad(`trusted patch manifest missing or unreadable: ${PATCH_MANIFEST_PATH} (required; post-hash verification is never optional)`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return failLoad(`trusted patch manifest is not valid JSON: ${PATCH_MANIFEST_PATH}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return failLoad('trusted patch manifest is not a JSON object');
  }
  if (manifest.schema !== 1 || manifest.repository !== UPSTREAM_REPO) {
    return failLoad(`trusted patch manifest identity mismatch: expected schema 1 for ${UPSTREAM_REPO}`);
  }
  if (typeof manifest.patch !== 'string' || !manifest.patch || manifest.patch.includes('/')
    || typeof manifest.patchSha256 !== 'string' || !SHA256_HEX.test(manifest.patchSha256)) {
    return failLoad('trusted patch manifest lacks a pinned patch file digest');
  }
  // The vendored patch file itself must match the manifest (tamper proof,
  // the same check apply.sh performs before applying anything).
  let patchBytes;
  try {
    patchBytes = readFileSyncCache(join(root, 'vendor/openbot/patches', manifest.patch));
  } catch {
    return failLoad(`vendored patch file missing: vendor/openbot/patches/${manifest.patch}`);
  }
  const patchDigest = createHash('sha256').update(patchBytes).digest('hex');
  if (patchDigest !== manifest.patchSha256) {
    return failLoad(`vendored patch file tampered: sha256 ${patchDigest} != manifest patchSha256`);
  }
  return { ok: true, manifest };
}

function serverBase(env) {
  const v = String(env.UPSTREAM_SERVER_URL ?? env.ME_UPSTREAM_SERVER_URL ?? 'http://127.0.0.1:3001').trim().replace(/\/$/, '');
  return v || 'http://127.0.0.1:3001';
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isManagedIntelligenceHost(apiUrl, wsUrl) {
  // URL-parsed hostname check (both authorities), not a raw substring over
  // config text. Managed = the CopilotKit cloud project host.
  for (const raw of [apiUrl, wsUrl]) {
    const host = raw ? hostOf(raw) : null;
    if (host && (host === 'copilotkit.ai' || host.endsWith('.copilotkit.ai'))) return true;
  }
  return false;
}

// TCP liveness for the Postgres product store (built-in net, no driver).
// Proves the port answers; the SQL layer is proven by migrate + server
// /health, never by URL syntax alone.
function tcpReachable(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const socket = connect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => { socket.destroy(); finish(true); });
    socket.once('timeout', () => { socket.destroy(); finish(false); });
    socket.once('error', () => finish(false));
    setTimeout(() => { socket.destroy(); finish(false); }, timeoutMs + 500).unref?.();
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Bounded response reader: hard byte cap + no redirect following on every
// secret-bearing probe. Redirects (301/302/307/308) are refused outright so
// Authorization/x-api-key material can never leak to another origin.
export const PROBE_MAX_BYTES = 262_144;

export async function boundedJson(res, { maxBytes = PROBE_MAX_BYTES } = {}) {
  if (!res) throw new Error('empty response');
  if (res.status >= 300 && res.status < 400) {
    throw Object.assign(new Error(`redirect refused (${res.status})`), { code: 'redirect_refused', status: res.status });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`response exceeds probe cap (${buf.length} > ${maxBytes} bytes)`);
  return JSON.parse(buf.toString('utf8') || 'null');
}

function secretFetch(fetchImpl) {
  // Same fetch, but redirects are manual so boundedJson can refuse them
  // instead of silently following with credentials attached.
  return (url, init = {}) => fetchImpl(url, { ...init, redirect: 'manual' });
}

async function loadIntelligenceSdk(sdkRoot = null) {
  const candidates = [];
  if (sdkRoot) {
    const req = createRequire(join(String(sdkRoot).replace(/\/$/, ''), 'package.json'));
    let version = null;
    try {
      version = req('@copilotkit/runtime/package.json')?.version ?? null;
    } catch (error) {
      throw new Error(`Intelligence SDK not found under INTELLIGENCE_SDK_ROOT=${sdkRoot}: ${error.message}`);
    }
    if (version !== INTELLIGENCE_SDK_PIN) {
      throw Object.assign(
        new Error(`Intelligence SDK version mismatch: found ${version}, required ${INTELLIGENCE_SDK_PIN} (npm i @copilotkit/runtime@${INTELLIGENCE_SDK_PIN})`),
        { code: 'sdk_version_mismatch', found: version, required: INTELLIGENCE_SDK_PIN },
      );
    }
    for (const spec of INTELLIGENCE_SDK_SPECIFIERS) {
      try {
        const resolved = req.resolve(spec);
        const mod = await import(resolved);
        if (mod?.CopilotKitIntelligence) return { Client: mod.CopilotKitIntelligence, version };
      } catch {
        /* try next specifier */
      }
    }
    throw new Error(`Intelligence SDK ${INTELLIGENCE_SDK_PIN} present but exports no CopilotKitIntelligence`);
  }
  let lastError = null;
  for (const spec of INTELLIGENCE_SDK_SPECIFIERS) {
    try {
      const mod = await import(spec);
      if (mod?.CopilotKitIntelligence) {
        let version = null;
        try {
          version = createRequire(import.meta.url)('@copilotkit/runtime/package.json')?.version ?? null;
        } catch { /* version unresolved; import already failed or private */ }
        if (version !== null && version !== INTELLIGENCE_SDK_PIN) {
          throw Object.assign(
            new Error(`Intelligence SDK version mismatch: found ${version}, required ${INTELLIGENCE_SDK_PIN}`),
            { code: 'sdk_version_mismatch', found: version, required: INTELLIGENCE_SDK_PIN },
          );
        }
        return { Client: mod.CopilotKitIntelligence, version };
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Intelligence SDK unavailable');
}

// Authenticated entitlement read via the OFFICIAL SDK (the same class the
// upstream server builds in server/src/intelligence-client.ts), evaluated
// with the upstream rules in server/src/intelligence-entitlement-check.ts:
// ready+active => licensed; misconfigured/expired license or 401/403 =>
// FAILED; unreachable/SDK-absent => NEEDS_INPUT (completable by installing
// the pinned package / providing key+license, never hardcoded).
async function checkIntelligenceEntitlement({ apiUrl, wsUrl, key, timeoutMs = 15000, clientFactory = null, sdkRoot = null }) {
  // clientFactory is a TEST-ONLY seam (unit tests inject a fake SDK client);
  // production always loads the pinned official package above.
  let sdkVersion = null;
  let Client;
  if (clientFactory) {
    Client = clientFactory;
  } else {
    const loaded = await loadIntelligenceSdk(sdkRoot);
    Client = loaded.Client;
    sdkVersion = loaded.version;
  }
  const client = new Client({ apiUrl, wsUrl, apiKey: key });
  try {
    const res = await withTimeout(
      client.getRuntimeEntitlements(),
      timeoutMs,
      'getRuntimeEntitlements',
    );
    if (res?.status === 'ready' && res?.entitlement?.active) return { ok: true, status: 'ready', active: true, sdkVersion };
    const code = res?.error?.code ?? null;
    if (code === 'RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED' || code === 'RUNTIME_ENTITLEMENTS_SELF_HOSTED_EXPIRED') {
      return { ok: false, failed: true, status: res?.status ?? 'not-ready', code, message: 'Intelligence licence missing/expired on its own deployment (COPILOTKIT_LICENSE_TOKEN belongs on the Intelligence chart, not on OpenBot alone)' };
    }
    return { ok: false, failed: false, status: res?.status ?? 'unknown', code, message: 'Intelligence did not confirm an active entitlement (licensed features such as memory may be refused)' };
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : null;
    if (status === 401 || status === 403) {
      return { ok: false, failed: true, status: 'unauthorized', code: null, message: 'Intelligence key rejected (401/403): bad key' };
    }
    return { ok: false, failed: false, status: 'unreachable', code: null, message: `Intelligence entitlement unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkFullNative({ env, fetchImpl, checks, need, fail, probe, sdkClient = null }) {
  // Upstream server /health (app.ts: app.get("/health") -> {status:ok}) plus
  // the REQUIRED anonymous-safe /api/capabilities projection (mode +
  // durableHistory must be present; absent means drift, not optional).
  const base = serverBase(env);
  const sfetch = secretFetch(fetchImpl);
  let serverOk = false;
  if (probe) {
    // Shared probe set (upstream-probes.mjs): the same /health +
    // /api/capabilities questions the live tracker's FULL tier asks. The
    // doctor keeps verdict ownership: answered-but-bad health is FAILED,
    // an unreachable server is NEEDS_INPUT, capabilities drift is FAILED.
    // (The doctor's base comes from serverBase above, not the shared
    // module's private-address-validating resolver: the doctor reports on
    // whatever is configured, it does not refuse non-private bases.)
    const health = await probeUpstreamHealth({ base, fetchImpl });
    if (!health.ok && health.error != null) {
      need(`upstream server unreachable at ${base}: ${health.error} (start pinned stack; see docs/upstream-deployment.md)`);
      checks.upstreamServer = { url: base, reachable: false };
    } else {
      checks.upstreamServer = { url: base, health: health.body ?? null };
      if (!health.ok) {
        fail(`upstream server /health did not answer {status:ok} at ${base}`);
      } else {
        const caps = await probeCapabilities({ base, fetchImpl });
        if (!caps.ok && caps.reason === 'unreachable') {
          need(`upstream server unreachable at ${base}: ${caps.error} (start pinned stack; see docs/upstream-deployment.md)`);
          checks.upstreamServer = { url: base, reachable: false };
        } else if (!caps.ok) {
          fail(`upstream server /api/capabilities missing required projection at ${base} (drift?)`);
        } else {
          checks.upstreamServer.capabilities = {
            mode: caps.mode, durableHistory: caps.durableHistory,
          };
          serverOk = true;
        }
      }
    }
  } else {
    checks.upstreamServer = { url: base, probed: false };
  }

  // Authenticated native reads: prove the patched auth seam + DB schema +
  // per-person provider, not just health/TCP. Both sign fresh single-use
  // probe assertions with the operator bridge secret (doctor-side,
  // read-only GETs only; fresh nonce per probe, never a standing credential).
  //   GET /api/agents (user role) => actor-filtered roster (ownedScope).
  //   GET /api/computers/fleet (admin role) => {isolation, computers[]} with
  //     per-person/per-bot computer keys (server/src/computer/gateway.ts).
  //   GET /api/computers/fleet (user role) => 403 (role gate enforced).
  // 401 anywhere => patch missing/misconfigured. A shared provider that
  // answers fleet to a user, or a non-array roster, fails the stack.
  if (probe && serverOk) {
    const bridgeSecret = String(env.ME_HOME_BRIDGE_SECRET ?? '').trim();
    if (!bridgeSecret) {
      need('full: ME_HOME_BRIDGE_SECRET missing (cannot run the native auth probes)');
      checks.nativeAuth = { probed: false };
    } else {
      // Shared probe set (upstream-probes.mjs probeNativeAuth) under the
      // doctor identity: the same signed reads the live tracker's FULL
      // tier runs. The doctor maps each stage outcome to its own
      // verdicts/messages below; the shared probe stops at the first
      // failure (verdict-identical: any stage failure already bars
      // READY), where the old inline flow also probed the remaining
      // stages for extra diagnostics.
      const auth = await probeNativeAuth({ base, bridgeSecret, fetchImpl, identity: DOCTOR_PROBE_IDENTITY });
      if (auth.ok) {
        checks.nativeAuth = auth.check;
      } else if (auth.reason === 'unreachable') {
        need(`full: ${auth.detail}`);
        checks.nativeAuth = { probed: true, authenticated: false };
      } else {
        checks.nativeAuth = auth.check;
        if (auth.stage === 'agents' && auth.reason === 'auth') {
          fail('full: native auth probe refused (401/403): home-bridge patch missing or bridge secret mismatch on the upstream host');
        } else if (auth.stage === 'agents') {
          fail(`full: native agents roster unreadable (${auth.status}): product DB schema or deployment drift?`);
        } else if (auth.stage === 'fleet' && auth.reason === 'auth') {
          fail('full: fleet admin probe refused (401/403): patch or admin mapping misconfigured on the upstream host');
        } else if (auth.stage === 'fleet') {
          fail(`full: fleet probe unreadable (${auth.status}): computer provider or schema drift?`);
        } else if (auth.stage === 'fleet-user') {
          fail(`full: shared provider answered fleet to a user assertion (${auth.status}): per-person computer isolation is not enforced`);
        }
      }
    }
  } else if (probe) {
    checks.nativeAuth = { probed: false };
  }

  // Postgres binding (product store; never the home SQLite facade). Syntax is
  // checked first; liveness is a real TCP dial, never the URL string alone.
  const dbUrl = String(env.DATABASE_URL ?? '').trim();
  checks.postgres = { configured: Boolean(dbUrl), binding: 'postgres-data:/var/lib/postgresql/data (pgvector/pg17)' };
  if (!dbUrl) need('full: DATABASE_URL missing (Postgres product store)');
  else if (!/^postgres(ql)?:\/\//.test(dbUrl)) fail('full: DATABASE_URL must be a postgres:// URL');
  else if (probe) {
    let host = null, port = 5432;
    try {
      const parsed = new URL(dbUrl);
      host = parsed.hostname;
      port = Number(parsed.port) || 5432;
    } catch { /* fall through to NEEDS_INPUT */ }
    if (!host) need('full: DATABASE_URL host unparseable');
    else {
      const live = await tcpReachable(host, port);
      checks.postgres.reachable = live;
      if (live) checks.postgres.live = `${host}:${port} answers TCP (SQL layer proven by migrate + server /health)`;
      else need(`full: Postgres unreachable at ${host}:${port} (start the FULL stack; TCP dial refused)`);
    }
  } else {
    checks.postgres.probed = false;
  }

  // Self-hosted Intelligence endpoint/key/entitlement (licensed). Both
  // authorities are resolved explicitly; the privacy gate uses parsed
  // hostnames. ONLY the authenticated SDK entitlement read can satisfy
  // this check — an anonymous health fetch never counts toward READY.
  const apiUrl = String(env.INTELLIGENCE_API_URL ?? '').trim();
  const wsUrl = String(env.INTELLIGENCE_GATEWAY_WS_URL ?? '').trim();
  const key = String(env.CPK_INTELLIGENCE_API_KEY ?? env.INTELLIGENCE_API_KEY ?? '').trim();
  const licenseToken = String(env.COPILOTKIT_LICENSE_TOKEN ?? '').trim();
  const managed = isManagedIntelligenceHost(apiUrl, wsUrl);
  const allowedManaged = ['1', 'true'].includes(String(env.ME_UPSTREAM_ALLOW_MANAGED_INTELLIGENCE ?? '').trim().toLowerCase());
  checks.intelligence = {
    apiHost: apiUrl ? hostOf(apiUrl) : null,
    gatewayHost: wsUrl ? hostOf(wsUrl) : null,
    keyPresent: Boolean(key),
    licenseTokenPresent: Boolean(licenseToken),
    selfHosted: Boolean(apiUrl) && !managed,
  };
  if (!apiUrl || !wsUrl || !key) need('full: Intelligence endpoint/key missing (INTELLIGENCE_API_URL + GATEWAY_WS_URL + CPK_INTELLIGENCE_API_KEY)');
  else if (managed && !allowedManaged) fail('full: managed Intelligence URL refused under home privacy default');
  else if (!probe) checks.intelligence.probed = false;
  else {
    let verdict;
    try {
      verdict = await checkIntelligenceEntitlement({ apiUrl, wsUrl, key, clientFactory: sdkClient, sdkRoot: env.INTELLIGENCE_SDK_ROOT ?? null });
    } catch (error) {
      if (error?.code === 'sdk_version_mismatch') {
        need(`full: ${error.message}`);
        checks.intelligence.sdkVersion = error.found ?? null;
      } else {
        need(`full: Intelligence SDK unavailable (@copilotkit/runtime @ ${INTELLIGENCE_SDK_PIN} not installed on this host; entitlement unverifiable here — install the pinned package under INTELLIGENCE_SDK_ROOT (npm i @copilotkit/runtime@${INTELLIGENCE_SDK_PIN}) or verify where the server image provides it; B's Python harness image does not supply the Node SDK): ${error instanceof Error ? error.message : String(error)}`);
        checks.intelligence.sdk = `absent (needs @copilotkit/runtime@${INTELLIGENCE_SDK_PIN})`;
      }
      verdict = null;
    }
    if (verdict) {
      checks.intelligence.entitlement = verdict.status;
      if (verdict.sdkVersion) checks.intelligence.sdkVersion = verdict.sdkVersion;
      if (verdict.ok) {
        if (verdict.sdkVersion && verdict.sdkVersion !== INTELLIGENCE_SDK_PIN) {
          need(`full: Intelligence SDK version ${verdict.sdkVersion} is not the pinned ${INTELLIGENCE_SDK_PIN}`);
        } else {
          checks.intelligence.licensed = true;
        }
      } else if (verdict.failed) fail(`full: Intelligence entitlement FAILED (${verdict.message})`);
      else need(`full: ${verdict.message}`);
    }
  }

  // Model: the SELECTED NATIVE model must be served, not merely configured.
  // Single source of truth shared with the harness container and the tenant
  // package: BOT_PROVIDER/BOT_MODEL + provider keys/base URL (NOT the legacy
  // HOME_MODEL_* selector — the doctor verifies what production runs). All
  // probes are read-only metadata (no inference spend): Ollama /api/tags,
  // OpenAI GET /v1/models, Anthropic GET /v1/models (official list API with
  // x-api-key + anthropic-version 2023-06-01), Google GET /v1beta/models.
  // Exact tag match only (google accepts the documented models/ id form);
  // redirects refused; responses byte-bounded.
  try {
    const model = resolveNativeModelConfig(env);
    checks.model = { provider: model.provider, model: model.model, endpoint: model.endpoint, keyEnv: model.keyEnv, keyPresent: Boolean(model.key) };
    if (!probe) checks.model.probed = false;
    else if (model.localRoute) {
      // LOCAL route stays doctor-local BY DESIGN (not the shared probe):
      // probeModelServed's local route is namespace-gated for the live
      // tracker (a host-side answer alone is never READY there), while
      // the doctor is a host-namespace CLI whose /api/tags proof has
      // always been host proof (docs/readiness-handshake-design.md
      // §1.4); it also surfaces the endpoint's HTTP status / error text
      // in its NEEDS_INPUT messages, which the shared namespace walk
      // deliberately collapses. Unifying would change one side's
      // pinned verdict semantics.
      try {
        const res = await sfetch(`${model.endpoint}/api/tags`, { signal: AbortSignal.timeout(8000) });
        const body = await boundedJson(res).catch(() => null);
        const names = Array.isArray(body?.models) ? body.models.map((m) => m?.name ?? m?.model).filter(Boolean) : [];
        checks.model.served = names;
        const served = names.some((n) => n === model.model || n === `${model.model}:latest`);
        if (!res.ok) need(`full: local model endpoint answered ${res.status} (Ollama-compatible at ${model.endpoint})`);
        else if (!served) need(`full: selected model ${model.model} not served locally (set BOT_MODEL to an exact tag and ollama pull it; tags: ${names.slice(0, 8).join(', ') || 'none'})`);
        else checks.model.selectedServed = true;
      } catch (error) {
        need(`full: local model unreachable at ${model.endpoint} (start Ollama or check OPENAI_BASE_URL): ${error.message}`);
        checks.model.reachable = false;
      }
    } else {
      // Remote provider routes (openai / anthropic / google) share ONE
      // implementation with the live tracker (upstream-probes.mjs
      // probeModelServed: provider list read, exact-id match, list-only
      // metadata, no namespace gate — the harness calls the provider API
      // directly). The shared detail strings are the doctor's own
      // messages (lifted verbatim), re-prefixed here; the doctor maps
      // key rejection (401/403) to FAILED and every other shortfall to
      // NEEDS_INPUT, exactly as its inline probes did. The shared check
      // additively records namespace:'host' (evidence completeness).
      const served = await probeModelServed({ env, fetchImpl });
      checks.model = {
        ...served.check,
        note: 'native harness model; list-only metadata check, no inference spend; scoped prompt/history only, never household store to vendor',
      };
      if (!served.ok) {
        // Doctor report schema (its own, supervisor-validated): a failed
        // model probe records no selectedServed/namespace verdict fields
        // at all — absence is the failure signal, as the inline probes
        // always emitted. (On success the shared namespace:'host' is
        // kept as additive evidence.)
        delete checks.model.selectedServed;
        delete checks.model.namespace;
        if (served.status === 401 || served.status === 403) fail(`full: ${served.detail}`);
        else need(`full: ${served.detail}`);
      }
    }
  } catch (error) {
    fail(`full: native model misconfigured (${error.message}); set BOT_PROVIDER + BOT_MODEL + provider key`);
    checks.model = { configured: false };
  }

  // Telemetry enforcement (home privacy default: upstream telemetry stays
  // off). Explicitly enabling product telemetry or disabling the kill
  // switches is a FAILED misconfiguration, not a note.
  checks.telemetry = {
    doNotTrack: env.DO_NOT_TRACK ?? null,
    disabled: env.COPILOTKIT_TELEMETRY_DISABLED ?? null,
    product: env.OPENBOT_PRODUCT_TELEMETRY ?? null,
    enforced: 'upstream telemetry must stay disabled (DO_NOT_TRACK=1 or COPILOTKIT_TELEMETRY_DISABLED=1)',
  };
  const teleOn = ['1', 'true'].includes(String(env.OPENBOT_PRODUCT_TELEMETRY ?? '').trim().toLowerCase());
  const teleOff = ['0', 'false'].includes(String(env.COPILOTKIT_TELEMETRY_DISABLED ?? '').trim().toLowerCase());
  const dntOff = ['0', 'false'].includes(String(env.DO_NOT_TRACK ?? '').trim().toLowerCase());
  if (teleOn) fail('full: OPENBOT_PRODUCT_TELEMETRY enabled (home privacy default forbids upstream telemetry)');
  if (teleOff) fail('full: COPILOTKIT_TELEMETRY_DISABLED explicitly off (home privacy default forbids upstream telemetry)');
  if (dntOff) fail('full: DO_NOT_TRACK explicitly off (home privacy default forbids upstream telemetry)');

  // Protected datastore bindings (C backup owner reads results/datastorage-contract.json).
  // World-writable storage dirs are a FAILED misconfiguration.
  checks.datastore = {
    volumes: ['postgres-data:/var/lib/postgresql/data', 'agent-workspace:/workspace', 'agent-profiles:/profiles'],
    note: 'full backup must include Postgres + Intelligence threads + computer files; see results/datastorage-contract.json',
  };
  const storageDirs = [];
  try {
    const s = await stat(`${process.cwd()}/data`).catch(() => null);
    if (s) storageDirs.push(['home-data', `${process.cwd()}/data`, s.mode]);
  } catch { /* best effort */ }
  for (const [label, path] of [['checkout', env.OPENBOT_CHECKOUT ?? '']]) {
    if (!path) continue;
    try {
      const s = statSync(path);
      storageDirs.push([label, path, s.mode]);
    } catch { /* absent checkout is reported by the source check */ }
  }
  for (const [label, path, mode] of storageDirs) {
    const oct = (mode & 0o777).toString(8);
    if (mode & 0o002) fail(`full: ${label} dir ${path} is world-writable (mode ${oct}; chmod o-w)`);
    else checks.datastore[label] = `${path} (mode ${oct})`;
  }

  // Upstream native push must stay disabled until a generic-only payload
  // hook is reviewed: with EXPO_PROJECT_ID set, upstream forwards up to 200
  // chars of chat text to Expo (delivery/push.ts). Home push stays generic.
  if (String(env.EXPO_PROJECT_ID ?? '').trim()) {
    fail('full: EXPO_PROJECT_ID is set on the upstream deployment: native push would forward chat text to Expo; leave unset until a generic-only payload hook is reviewed');
  }
}

// Bounded live-evidence cache: the doctor writes it (CLI --cache), the home
// server reads it (sibling of dbPath) to derive fullConfigured. Fresh READY
// evidence only; anything else (missing/stale/non-READY/pin mismatch) means
// setup-needed, never configured.
export const DOCTOR_CACHE_TTL_MS = 300_000;
export const DOCTOR_CACHE_PROTOCOL = 'upstream-platform-v1';

export function doctorCachePath(dbPath) {
  return joinDir(dbPath, 'doctor-cache.json');
}

function joinDir(dbPath, name) {
  const dir = String(dbPath).split('/').slice(0, -1).join('/') || '.';
  return `${dir}/${name}`;
}

export const DOCTOR_CACHE_MAX_BYTES = 4096;

export function writeDoctorCache(cachePath, report, { at = Date.now(), ttlMs = DOCTOR_CACHE_TTL_MS, fs = null } = {}) {
  const payload = {
    protocol: DOCTOR_CACHE_PROTOCOL,
    state: report?.state ?? 'UNKNOWN',
    mode: report?.checks?.mode ?? null,
    pin: UPSTREAM_PIN,
    at,
    ttlMs,
  };
  const data = JSON.stringify(payload);
  if (data.length > DOCTOR_CACHE_MAX_BYTES) throw new Error('doctor cache payload exceeds byte cap');
  if (fs?.writeFileSync) {
    // Atomic: tmp + rename so readers never see a torn file. Plain write
    // when the seam provides no rename (tests).
    if (fs.renameSync) {
      fs.writeFileSync(`${cachePath}.tmp`, data);
      fs.renameSync(`${cachePath}.tmp`, cachePath);
    } else {
      fs.writeFileSync(cachePath, data);
    }
  }
  return payload;
}

export function readLiveEvidence(cachePath, { at = Date.now(), fs = null } = {}) {
  try {
    const raw = fs?.readFileSync ? fs.readFileSync(cachePath, 'utf8') : readFileSyncCache(cachePath, 'utf8');
    if (typeof raw !== 'string' || raw.length > DOCTOR_CACHE_MAX_BYTES) {
      return { live: false, reason: 'oversize' };
    }
    const payload = JSON.parse(raw);
    if (payload?.protocol !== DOCTOR_CACHE_PROTOCOL) return { live: false, reason: 'bad-protocol' };
    if (payload?.pin !== UPSTREAM_PIN) return { live: false, reason: 'pin-mismatch' };
    if (payload?.mode !== 'full' || payload?.state !== 'READY') return { live: false, reason: 'not-ready' };
    if (!Number.isFinite(payload?.at) || !Number.isFinite(payload?.ttlMs)) return { live: false, reason: 'bad-envelope' };
    if (at - payload.at > payload.ttlMs || at < payload.at - 60_000) {
      return { live: false, reason: 'stale' };
    }
    return { live: true, at: payload.at, ttlMs: payload.ttlMs };
  } catch {
    return { live: false, reason: 'missing' };
  }
}

// Deployed-checkout verification (local evidence, never remote files).
// Trust comes from git state against the lock, not from marker substrings:
//   1. git HEAD must equal the lock revision (bound to the pin by the lock).
//   2. `git status` must show ONLY the approved patch footprint: modified
//      tracked files ⊆ {server/src/index.ts, server/src/config.ts} (the F
//      patch seam, index.ts mandatory), untracked ⊆ {home-bridge.ts,
//      node_modules/, .openbot/, egress.env, .langchain/}. Any other tracked
//      drift or unapproved new source file is a FAILED refusal.
//   3. Every lock file's LOCAL sha256 must match, EXCEPT the approved
//      modified set (expected to differ post-patch; their exact bytes are
//      pinned by the REQUIRED trusted patch manifest instead).
//   4. The trusted patch manifest (F-owned,
//      vendor/openbot/patches/manifest.json) is REQUIRED, never optional:
//      its files[*].postSha256 post-hashes are enforced exactly, every
//      approved seam file must be pinned by it, its per-file
//      originalSha256 must agree with the lock wherever both record the
//      file, its baseCommit must equal the lock revision, and its
//      unmodified[*] digests are enforced for every seam file present
//      (sparse verification checkouts may omit seams — apply.sh parity;
//      a tracked deletion is already refused by rule 2). A missing,
//      malformed or schema-foreign manifest is a FAILED refusal.
//   5. Markers remain as defense-in-depth only, never as sole proof.
// Returns {ok, missing, reason, report}.
export const APPROVED_MODIFIED = new Set(['server/src/index.ts', 'server/src/config.ts']);
export const APPROVED_UNTRACKED = ['server/src/home-bridge.ts', 'node_modules/', '.openbot/', 'egress.env', '.langchain/'];

export function verifyDeployedCheckout(checkout, lock, { manifest = null } = {}) {
  const failOut = (reason, report, missing = false) => ({ ok: false, reason, report, missing });
  try {
    const st = statSync(checkout);
    if (!st.isDirectory()) return failOut(`OPENBOT_CHECKOUT is not a directory: ${checkout}`, { configured: true }, true);
  } catch {
    return failOut(`OPENBOT_CHECKOUT not provisioned: ${checkout}`, { configured: true }, true);
  }
  let head = null;
  try {
    head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { timeout: 15000, encoding: 'utf8' }).trim();
  } catch {
    return failOut(`deployed checkout is not a git tree: ${checkout}`, { configured: true }, true);
  }
  const report = { configured: true, head };
  const want = lock?.revision ?? UPSTREAM_PIN;
  if (head !== want) {
    return failOut(`deployed HEAD ${head} != locked ${want} (source drift)`, report);
  }
  // 2. Approved footprint only.
  let status = '';
  try {
    status = execFileSync('git', ['-C', checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: 15000, encoding: 'utf8' });
  } catch {
    return failOut('deployed checkout git status unreadable', report);
  }
  const modified = new Set();
  const created = [];
  for (const entry of status.split('\0')) {
    if (!entry) continue;
    const code = entry.slice(0, 2);
    let path = entry.slice(3);
    if (code[0] === 'R') path = path.split(' -> ').pop();
    if (code === '??') created.push(path);
    else modified.add(path);
  }
  for (const path of modified) {
    if (!APPROVED_MODIFIED.has(path)) {
      return failOut(`unexpected tracked drift (only the approved patch seam may differ): ${path}`, report);
    }
  }
  if (!modified.has('server/src/index.ts')) {
    return failOut('assembly seam untouched (approved patch not applied): server/src/index.ts unmodified', report);
  }
  for (const path of created) {
    if (!APPROVED_UNTRACKED.some((a) => path === a || path.startsWith(a))) {
      return failOut(`unapproved new source file in deployed checkout: ${path}`, report);
    }
  }
  // 3. Lock hashes for everything outside the approved modified set.
  let checked = 0;
  for (const [name, digest] of Object.entries(lock?.files ?? {})) {
    if (APPROVED_MODIFIED.has(name)) continue;
    let data;
    try {
      data = readFileSyncCache(join(checkout, name));
    } catch {
      return failOut(`deployed checkout lacks locked file: ${name}`, report);
    }
    const got = createHash('sha256').update(data).digest('hex');
    if (got !== digest) return failOut(`deployed file drift vs lock: ${name} (unexpected change outside the approved seam)`, report);
    checked++;
  }
  report.filesOk = checked;
  // 4. Trusted patch manifest (F-owned) is REQUIRED and enforced exactly.
  //    No manifest, no verification: structural rules + markers alone can
  //    never prove the deployed bytes are the approved post-patch bytes.
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return failOut('trusted patch manifest missing (vendor/openbot/patches/manifest.json is required; post-hash verification is never optional)', report);
  }
  const post = manifest.files;
  if (!post || typeof post !== 'object' || Array.isArray(post) || Object.keys(post).length === 0) {
    return failOut('trusted patch manifest has no files map (schema 1: {files: {path: {originalSha256, postSha256}}})', report);
  }
  if (manifest.baseCommit != null && manifest.baseCommit !== want) {
    return failOut(`patch manifest baseCommit ${manifest.baseCommit} != locked ${want}`, report);
  }
  for (const seam of APPROVED_MODIFIED) {
    if (!(seam in post)) return failOut(`approved seam file not pinned by trusted patch manifest: ${seam}`, report);
  }
  for (const [name, entry] of Object.entries(post)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.postSha256 !== 'string' || !SHA256_HEX.test(entry.postSha256)) {
      return failOut(`patch manifest entry is not the {originalSha256, postSha256} schema: ${name}`, report);
    }
    if (entry.originalSha256 != null) {
      if (typeof entry.originalSha256 !== 'string' || !SHA256_HEX.test(entry.originalSha256)) {
        return failOut(`patch manifest originalSha256 malformed: ${name}`, report);
      }
      const locked = lock?.files?.[name];
      if (locked && locked !== entry.originalSha256) {
        return failOut(`patch manifest original hash disagrees with the vendor lock: ${name}`, report);
      }
    }
    let data;
    try {
      data = readFileSyncCache(join(checkout, name));
    } catch {
      return failOut(`manifest-pinned file absent in deployed checkout: ${name}`, report);
    }
    const got = createHash('sha256').update(data).digest('hex');
    if (got !== entry.postSha256) return failOut(`deployed file differs from trusted patch manifest post-hash: ${name}`, report);
  }
  report.manifestOk = Object.keys(post).length;
  const unmodified = manifest.unmodified ?? {};
  if (!unmodified || typeof unmodified !== 'object' || Array.isArray(unmodified)) {
    return failOut('trusted patch manifest unmodified map is malformed (schema 1: {path: sha256})', report);
  }
  let unmodifiedOk = 0;
  for (const [name, digest] of Object.entries(unmodified)) {
    if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) {
      return failOut(`patch manifest unmodified digest malformed: ${name}`, report);
    }
    let data;
    try {
      data = readFileSyncCache(join(checkout, name));
    } catch {
      // Sparse verification checkouts may omit a seam file entirely
      // (apply.sh parity); a tracked deletion is refused by rule 2.
      continue;
    }
    const got = createHash('sha256').update(data).digest('hex');
    if (got !== digest) return failOut(`unmodified seam drift vs trusted patch manifest: ${name}`, report);
    unmodifiedOk++;
  }
  report.manifestUnmodifiedOk = unmodifiedOk;
  // 5. Markers: corroboration only.
  let bridge = '';
  try {
    bridge = readFileSyncCache(join(checkout, 'server/src/home-bridge.ts'), 'utf8');
  } catch {
    return failOut('applied patch missing: server/src/home-bridge.ts absent', report);
  }
  for (const marker of ['wrapAuthWithHomeBridge', 'ME_HOME_BRIDGE_SECRET', 'timingSafeEqual']) {
    if (!bridge.includes(marker)) return failOut(`applied patch marker absent in home-bridge.ts: ${marker}`, report);
  }
  let index = '';
  try {
    index = readFileSyncCache(join(checkout, 'server/src/index.ts'), 'utf8');
  } catch {
    return failOut('assembly seam missing: server/src/index.ts absent', report);
  }
  if (!index.includes('wrapAuthWithHomeBridge(homeAuth')) {
    return failOut('assembly hook missing in index.ts (patch not applied)', report);
  }
  report.patchApplied = true;
  return { ok: true, reason: `deployed checkout verified (HEAD ${head.slice(0, 12)}, ${checked} files, approved seam only, manifest post-hashes match)`, report };
}

export async function checkUpstreamPlatform({ env = process.env, fetchImpl = fetch, repoRoot = null, probe = true, sdkClient = null, deployedVerifier = null } = {}) {
  const checks = { doctor_contract: DOCTOR_CONTRACT };
  let state = 'READY';
  const need = (reason) => { if (state === 'READY') state = 'NEEDS_INPUT'; (checks.needs ??= []).push(reason); };
  const fail = (reason) => { state = 'FAILED'; (checks.failures ??= []).push(reason); };
  // Vendor manifest resolves from the installed module root, never the
  // caller's cwd (installer may invoke from a setup/data dir). Explicit
  // repoRoot still overrides (tests, alternate layouts).
  const root = repoRoot ?? moduleRepoRoot();

  let resolved;
  try {
    resolved = resolveUpstreamConfig(env);
    checks.mode = resolved.mode;
    checks.upstream = resolved.upstream;
  } catch (error) {
    return { protocol: 'upstream-platform-v1', doctor_contract: DOCTOR_CONTRACT, state: 'FAILED', checks: { doctor_contract: DOCTOR_CONTRACT, failures: [String(error.message)], mode: 'unknown' } };
  }

  // 1. Source pin verified: lock format + pinned revision + DEPLOYED checkout
  // (local HEAD must equal the pin, every lock file's LOCAL sha256 must
  // match, the approved patch ledger must be applied). Lock-format alone
  // never satisfies this check.
  const lock = await readLock(root);
  if (!lock) {
    fail('vendor/openbot/upstream.json missing or unreadable');
  } else if (lock.repository !== UPSTREAM_REPO || lock.revision !== UPSTREAM_PIN || lock.branch !== 'main') {
    fail(`source pin mismatch: expected ${UPSTREAM_REPO}@${UPSTREAM_PIN}, got ${lock.repository}@${lock.revision}`);
  } else {
    checks.sourcePin = { repo: lock.repository, ref: lock.revision, files: Object.keys(lock.files).length, verified: 'lock-format' };
    const checkout = String(env.OPENBOT_CHECKOUT ?? '').trim();
    if (!checkout && resolved.mode === 'full') {
      need('full: OPENBOT_CHECKOUT not configured (deployed pinned checkout with applied patch is required)');
      checks.sourcePin.deployed = { configured: false };
    } else if (checkout) {
      // deployedVerifier is a TEST-ONLY seam; production always runs the
      // real verifier above. The trusted patch manifest is F-owned
      // (vendor/openbot/patches/manifest.json) and REQUIRED: loading is
      // fail-closed, so a missing, unreadable or tampered manifest is a
      // FAILED refusal here, never a silent downgrade to structural-only
      // verification.
      const verify = deployedVerifier ?? verifyDeployedCheckout;
      let dep;
      if (deployedVerifier) {
        dep = verify(checkout, lock);
      } else {
        const loaded = loadPatchManifest(root);
        dep = loaded.ok
          ? verify(checkout, lock, { manifest: loaded.manifest })
          : { ok: false, missing: false, reason: loaded.reason, report: { configured: true, manifestOk: false } };
      }
      checks.sourcePin.deployed = dep.report;
      if (!dep.ok) {
        if (dep.missing) need(`deployed checkout not provisioned: ${dep.reason}`);
        else fail(`deployed checkout: ${dep.reason}`);
      } else {
        checks.sourcePin.deployed.ok = true;
      }
    }
  }

  // 2. Config: CORE tokens present? FULL gate (licensed self-hosted primary)?
  if (resolved.mode === 'core') {
    if (resolved.missing.length > 0) need(`core computer plane missing: ${resolved.missing.join(', ')}`);
    checks.config = { missing: resolved.missing, note: 'standalone core is dev/partial; FULL is the primary goal' };
  } else {
    const gate = gateFullConfig(resolved);
    checks.config = { missing: resolved.missing, gate: gate.ok ? 'pass' : gate.reason };
    if (!gate.ok) {
      // Missing credentials/license => NEEDS_INPUT; unsafe/privacy => FAILED.
      if (/missing|license|INTELLIGENCE|BETTER_AUTH|INITIAL_ADMIN|DATABASE/i.test(gate.reason)) need(`full: ${gate.reason}`);
      else fail(`full: ${gate.reason}`);
    }
    // FULL must never READY from empty health proxy alone (checked below).
  }

  // 3. Supervisor + per-user boundary (probe only when tokens present).
  // docker:false is NOT READY (computers cannot run); docker missing means
  // this is not the upstream supervisor at all.
  const c = resolved.computer;
  if (c.supervisorUrl && c.supervisorToken) {
    if (probe) {
      try {
        const client = createSupervisorClient({ baseUrl: c.supervisorUrl, token: c.supervisorToken, fetchImpl: secretFetch(fetchImpl), timeoutMs: 8000 });
        const health = await client.health().catch(() => null);
        const docker = health?.docker;
        checks.supervisor = { url: c.supervisorUrl, health: health ?? null };
        if (!health || health.status !== 'ok') {
          fail('supervisor /health did not answer {status:ok}');
        } else if (docker !== true) {
          fail(`supervisor reports docker:${String(docker)} (computers cannot run; not READY${docker === false ? '' : ' and not the upstream supervisor shape'})`);
        } else {
          // Token validation: authed list must not 401.
          try {
            const listed = await client.list();
            checks.supervisor.list = Array.isArray(listed?.computers) ? `ok (${listed.computers.length})` : 'ok (unlisted shape)';
          } catch (error) {
            if (error?.code === 'upstream_unauthorized') fail('SUPERVISOR_TOKEN rejected (401)');
            else need(`supervisor list unavailable: ${error.message}`);
          }
        }
      } catch (error) {
        need(`supervisor unreachable: ${error.message}`);
      }
    } else {
      checks.supervisor = { url: c.supervisorUrl, probed: false };
    }
    // Per-user boundary static check (no network): mapping must be 1:1 ids.
    try {
      checkUpstreamId('person-probe-id'.replace(/-/g, '_'), 'person');
      checks.perUserBoundary = 'id-rules-loaded (names.ts ALLOWED)';
    } catch {
      fail('per-user id rules broken');
    }
  } else {
    checks.supervisor = { url: c.supervisorUrl ?? null, probed: false };
  }

  // 4. Versions: image tags must be pinned names, never :latest-mutable claim.
  checks.versions = { computerImage: c.computerImage, namespace: c.namespace, checkout: c.checkout, pin: UPSTREAM_PIN };
  if (/:latest$/.test(c.computerImage)) {
    // :latest tag is what upstream compose defaults to; CI resolves digests.
    // Not a failure, but recorded so acceptance resolves digests on Linux.
    checks.versions.note = 'image tag :latest default; CI must resolve digest (docker inspect) on Linux';
  }

  // 5. License gate: CORE never requires CopilotKit license; FULL requires it.
  checks.license = resolved.mode === 'core'
    ? { required: false, note: 'CORE computer plane is MIT-only; no Intelligence/license needed (dev/partial)' }
    : { required: true, keyPresent: Boolean(resolved.full?.intelligenceKey), managedOptIn: Boolean(resolved.allowManaged), note: 'licensed self-hosted Intelligence; no managed cloud default' };
  if (resolved.mode === 'full' && !resolved.full?.intelligenceKey) need('full: CPK_INTELLIGENCE_API_KEY missing');

  // 6. FULL-only: native stack components (server, Postgres, Intelligence,
  // model, telemetry, datastore). Each is NEEDS_INPUT when unconfigured, FAILED
  // when unsafe. None can make FULL READY alone; all must pass together.
  if (resolved.mode === 'full') {
    await checkFullNative({ env, fetchImpl, checks, need, fail, probe, sdkClient });
  }

  // probe=false never yields production READY: an unverified stack is at
  // most NEEDS_INPUT (run the live check with credentials to complete).
  // The gate is recorded even when other NEEDS_INPUTs already fired; FAILED
  // stays FAILED (a failed stack is not rescuable by probing).
  checks.probe = probe;
  if (!probe && state !== 'FAILED') {
    if (state === 'READY') state = 'NEEDS_INPUT';
    (checks.needs ??= []).push('probe disabled: live verification not performed (re-run with probing to complete setup)');
  }

  return { protocol: 'upstream-platform-v1', doctor_contract: DOCTOR_CONTRACT, state, checks };
}
