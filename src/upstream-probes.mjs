// Shared FULL-tier probe set for the readiness handshake (OPEN #4).
//
// These are the doctor's native-auth / fleet / model-served probe blocks
// (upstream-doctor.mjs checkFullNative semantics, preserved verbatim) lifted
// into one module so BOTH the on-demand doctor verdicts and the home
// server's periodic live tracker (upstream-live.mjs) evaluate the same
// evidence. The doctor keeps verdict/schema ownership of its own report;
// this module only answers bounded, read-only probe questions and never
// throws for network/untrusted input — failures come back as
// {ok:false, reason} with reason in:
//   config | unreachable | drift | auth | fleet | model | timeout
//
// Assertion discipline (unchanged from the doctor): every authenticated
// request signs a FRESH single-use home assertion; identities are
// 'me-doctor-probe' (doctor CLI) and 'me-live-probe' (tracker). Assertions
// are never cached and never logged.
//
// Container-namespace Ollama proof (local route): the model check asks, in
// order, (1) the harness ITSELF for its served-model view (the answer
// originates inside the harness container, proving the exact namespace
// inference runs in), (2) a supervisor-side witness route (a container
// namespace in the compose stack), and only then (3) the host-side
// /api/tags read the doctor has always done. Evidence records
// model.namespace = 'harness' | 'supervisor' | 'host'; for the local route
// a verdict is only ok when the SELECTED tag is served AND the proof came
// from a container namespace — 'host' alone never proves readiness.
// The harness/supervisor surfaces are env-wired (ME_HARNESS_MODEL_URL /
// ME_SUPERVISOR_PROBE_URL, with compose-derived defaults); their live
// behaviour against the real containers is Docker-gated and NOT verified
// in environments without Docker — the namespace fetchers are an injected
// seam (namespaceFetchers) so unit tests cover the logic with fakes.

import { signHomeAssertion, ASSERTION_HEADER } from './upstream-proxy.mjs';
import { boundedJson } from './upstream-doctor.mjs';
import { resolveNativeModelConfig } from './runtime-config.mjs';

export const PROBE_REQUEST_TIMEOUT_MS = 8_000;
export const FULL_PROBE_BUDGET_MS = 30_000;
export const TRACKER_PROBE_IDENTITY = 'me-live-probe';
export const DOCTOR_PROBE_IDENTITY = 'me-doctor-probe';

// Same private-address rule as the light tracker (upstream-live.mjs): the
// upstream server may only ever be a loopback or compose-service address.
export function upstreamServerBase(env = process.env) {
  const base = String(env.UPSTREAM_SERVER_URL ?? env.ME_UPSTREAM_SERVER_URL ?? 'http://127.0.0.1:3001').trim().replace(/\/$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base) && !base.startsWith('http://upstream:')) {
    throw new Error('UPSTREAM_SERVER_URL must be a private loopback/compose address');
  }
  return base;
}

function noRedirect(fetchImpl) {
  return (url, init = {}) => fetchImpl(url, { ...init, redirect: 'manual' });
}

// Upstream /health must answer {status:'ok'} (doctor + light semantics).
// Additive fields for the doctor consumer (the tracker ignores them):
// `body` carries the parsed health body (the doctor records it as
// evidence); a thrown fetch returns `error` (and no `status`), so the
// doctor can tell "unreachable" (NEEDS_INPUT) from "answered badly"
// (FAILED) exactly as its inline probe did.
export async function probeUpstreamHealth({ base, fetchImpl = fetch, timeoutMs = PROBE_REQUEST_TIMEOUT_MS } = {}) {
  const get = noRedirect(fetchImpl);
  try {
    const res = await get(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await boundedJson(res).catch(() => null);
    if (!res.ok || body?.status !== 'ok') return { ok: false, reason: 'unreachable', status: res.status ?? null, body };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, reason: 'unreachable', error: error.message };
  }
}

// REQUIRED anonymous-safe /api/capabilities projection: mode +
// durableHistory must both be present; absent means drift, not optional.
export async function probeCapabilities({ base, fetchImpl = fetch, timeoutMs = PROBE_REQUEST_TIMEOUT_MS } = {}) {
  const get = noRedirect(fetchImpl);
  try {
    const res = await get(`${base}/api/capabilities`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await boundedJson(res).catch(() => null);
    if (!res.ok || body?.mode == null || body?.durableHistory == null) {
      return { ok: false, reason: 'drift', status: res.status ?? null };
    }
    return { ok: true, mode: body.mode, durableHistory: body.durableHistory };
  } catch (error) {
    // Additive `error` for the doctor consumer (tracker ignores it).
    return { ok: false, reason: 'unreachable', error: error.message };
  }
}

// Authenticated native reads — the doctor's fleet/role block verbatim:
//   GET /api/agents (user)            => 200 + actor-filtered roster array
//   GET /api/computers/fleet (admin)  => 200 + {isolation, computers[]} with
//                                        per-person keys counted
//   GET /api/computers/fleet (user)   => must be denied (403, or 401 as the
//                                        doctor has always accepted); any
//                                        success = isolation not enforced
// 401/403 on the signed agents/fleet-admin reads => bridge patch/secret
// misconfiguration (reason 'auth').
// Additive fields for the doctor consumer (the tracker ignores them):
// `stage` names which read failed ('agents' | 'fleet' | 'fleet-user') and
// `status` carries its HTTP status, so the doctor can reproduce its own
// per-stage verdict messages exactly.
export async function probeNativeAuth({
  base, bridgeSecret, fetchImpl = fetch, timeoutMs = PROBE_REQUEST_TIMEOUT_MS,
  identity = TRACKER_PROBE_IDENTITY,
} = {}) {
  if (!bridgeSecret) return { ok: false, reason: 'config', stage: 'config', detail: 'ME_HOME_BRIDGE_SECRET missing' };
  const get0 = noRedirect(fetchImpl);
  const sign = (role) => signHomeAssertion({ upstreamUserId: identity, role, bridgeSecret });
  const get = (path, role) => get0(`${base}${path}`, {
    headers: { [ASSERTION_HEADER]: sign(role) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const check = { probed: true };
  try {
    const agents = await get('/api/agents', 'user');
    const agentsBody = await boundedJson(agents).catch(() => null);
    if (agents.status === 401 || agents.status === 403) {
      return { ok: false, reason: 'auth', stage: 'agents', status: agents.status, detail: 'native auth probe refused (401/403): home-bridge patch missing or bridge secret mismatch', check: { ...check, authenticated: false } };
    }
    if (!agents.ok || !Array.isArray(agentsBody?.agents)) {
      return { ok: false, reason: 'drift', stage: 'agents', status: agents.status, detail: `native agents roster unreadable (${agents.status})`, check: { ...check, authenticated: true } };
    }
    check.authenticated = true;
    check.agents = agentsBody.agents.length;
    check.perPersonRoster = true;
    const fleet = await get('/api/computers/fleet', 'admin');
    const fleetBody = await boundedJson(fleet).catch(() => null);
    if (fleet.status === 401 || fleet.status === 403) {
      return { ok: false, reason: 'auth', stage: 'fleet', status: fleet.status, detail: 'fleet admin probe refused (401/403): patch or admin mapping misconfigured', check };
    }
    if (!fleet.ok || !Array.isArray(fleetBody?.computers) || typeof fleetBody?.isolation === 'undefined') {
      return { ok: false, reason: 'fleet', stage: 'fleet', status: fleet.status, detail: `fleet probe unreadable (${fleet.status})`, check };
    }
    check.fleet = {
      computers: fleetBody.computers.length,
      isolation: fleetBody.isolation ?? null,
      personKeys: fleetBody.computers.filter((c) => c?.kind === 'person' || typeof c?.personId === 'string').length,
    };
    const userFleet = await get('/api/computers/fleet', 'user');
    await boundedJson(userFleet).catch(() => null);
    if (userFleet.status === 403 || userFleet.status === 401) {
      check.roleGate = 'user-denied';
      check.perPerson = true;
      return { ok: true, check };
    }
    return {
      ok: false, reason: 'fleet', stage: 'fleet-user', status: userFleet.status,
      detail: `shared provider answered fleet to a user assertion (${userFleet.status}): per-person computer isolation is not enforced`,
      check,
    };
  } catch (error) {
    return { ok: false, reason: 'unreachable', stage: 'exception', detail: `native auth probe unreadable: ${error.message}`, check: { ...check, authenticated: false } };
  }
}

function tagNames(body) {
  // Ollama /api/tags shape: {models:[{name|model}]}.
  if (Array.isArray(body?.models)) return body.models.map((m) => m?.name ?? m?.model).filter(Boolean);
  return null;
}

function openAiIds(body) {
  // OpenAI-style model list: {data:[{id}]}.
  if (Array.isArray(body?.data)) return body.data.map((m) => m?.id).filter(Boolean);
  return null;
}

function modelListNames(body) {
  return tagNames(body) ?? openAiIds(body);
}

function tagServed(names, model) {
  return names.some((n) => n === model || n === `${model}:latest`);
}

// Default container-namespace fetchers for the local (Ollama) route. Each
// returns a served-name list, or null when that namespace cannot answer
// (unreachable / bad shape) — a namespace that ANSWERS is definitive: its
// list decides, there is no fall-through to a weaker namespace. Env seams:
//   ME_HARNESS_MODEL_URL     full URL of the harness's own model-list view
//   ME_HARNESS_URL / PICKED_HARNESS_URL / MANAGED_AGENT_AG_UI_URL
//                            harness base (compose publishes 127.0.0.1:4206)
//   ME_SUPERVISOR_PROBE_URL  full URL of the supervisor witness route
//   COMPUTER_SUPERVISOR_URL  witness base (route /probe/model-tags)
export function defaultNamespaceFetchers(env = process.env, fetchImpl = fetch, timeoutMs = PROBE_REQUEST_TIMEOUT_MS) {
  const get = noRedirect(fetchImpl);
  const readNames = async (url, headers = {}) => {
    const res = await get(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await boundedJson(res).catch(() => null);
    return body ? modelListNames(body) : null;
  };
  const harnessBase = String(env.ME_HARNESS_URL ?? env.PICKED_HARNESS_URL ?? env.MANAGED_AGENT_AG_UI_URL ?? 'http://127.0.0.1:4206').trim().replace(/\/$/, '');
  const harnessUrl = String(env.ME_HARNESS_MODEL_URL ?? '').trim() || `${harnessBase}/models`;
  const harnessHeaders = env.MANAGED_AGENT_TOKEN ? { authorization: `Bearer ${env.MANAGED_AGENT_TOKEN}` } : {};
  const supervisorBase = String(env.COMPUTER_SUPERVISOR_URL ?? '').trim().replace(/\/$/, '');
  const supervisorUrl = String(env.ME_SUPERVISOR_PROBE_URL ?? '').trim()
    || (supervisorBase ? `${supervisorBase}/probe/model-tags` : null);
  const supervisorHeaders = env.SUPERVISOR_TOKEN ? { authorization: `Bearer ${env.SUPERVISOR_TOKEN}` } : {};
  return [
    { namespace: 'harness', fetchNames: () => readNames(harnessUrl, harnessHeaders) },
    ...(supervisorUrl
      ? [{ namespace: 'supervisor', fetchNames: () => readNames(supervisorUrl, supervisorHeaders) }]
      : []),
    { namespace: 'host', fetchNames: null }, // filled by probeModelServed (needs the resolved endpoint)
  ];
}

// Model-served proof. Local route = container-namespace proof (above);
// remote routes keep the doctor's provider-list semantics (the harness
// calls the provider API directly, so the namespace gate does not apply —
// namespace is recorded as 'host' for evidence completeness).
export async function probeModelServed({
  env = process.env, fetchImpl = fetch, timeoutMs = PROBE_REQUEST_TIMEOUT_MS,
  namespaceFetchers = null,
} = {}) {
  let model;
  try {
    model = resolveNativeModelConfig(env);
  } catch (error) {
    return { ok: false, reason: 'config', detail: error.message, check: { configured: false } };
  }
  const check = {
    provider: model.provider, model: model.model, endpoint: model.endpoint,
    keyEnv: model.keyEnv, keyPresent: Boolean(model.key),
  };
  const get = noRedirect(fetchImpl);
  if (model.localRoute) {
    const fetchers = namespaceFetchers ?? defaultNamespaceFetchers(env, fetchImpl, timeoutMs);
    for (const fetcher of fetchers) {
      let names = null;
      try {
        names = fetcher.namespace === 'host'
          ? await (async () => {
            const res = await get(`${model.endpoint}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) return null;
            const body = await boundedJson(res).catch(() => null);
            return body ? tagNames(body) : null;
          })()
          : await fetcher.fetchNames();
      } catch { names = null; }
      if (!Array.isArray(names)) continue; // namespace could not answer; try the next one
      const served = tagServed(names, model.model);
      const containerProven = fetcher.namespace === 'harness' || fetcher.namespace === 'supervisor';
      check.served = names;
      check.selectedServed = served;
      check.namespace = fetcher.namespace;
      check.containerProven = containerProven;
      if (!served) {
        return { ok: false, reason: 'model', detail: `selected model ${model.model} not served (namespace ${fetcher.namespace}; tags: ${names.slice(0, 8).join(', ') || 'none'})`, check };
      }
      if (!containerProven) {
        return { ok: false, reason: 'model', detail: `selected model ${model.model} is served host-side but no container namespace proved it (READY requires namespace 'harness' or 'supervisor', never 'host' alone)`, check };
      }
      return { ok: true, check };
    }
    return { ok: false, reason: 'model', detail: `local model unreachable in every namespace at ${model.endpoint} (start Ollama or check OPENAI_BASE_URL)`, check: { ...check, reachable: false, namespace: null, selectedServed: false } };
  }
  // Remote provider routes (doctor semantics, list-only metadata).
  if (!model.key) {
    return { ok: false, reason: 'model', detail: `${model.keyEnv} missing (native ${model.provider} key required; no inference without it)`, check: { ...check, namespace: 'host', selectedServed: false } };
  }
  try {
    let ids = null;
    if (model.provider === 'openai' || model.provider === 'anthropic') {
      const isAnthropic = model.provider === 'anthropic';
      const res = await get(`${model.endpoint}${isAnthropic ? '/v1/models' : '/models'}`, {
        headers: isAnthropic
          ? { 'x-api-key': model.key, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${model.key}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await boundedJson(res).catch(() => null);
      if (res.status === 401 || res.status === 403) {
        // Additive `status` (doctor consumer): key rejection is a FAILED
        // verdict there, every other non-ok answer is NEEDS_INPUT.
        return { ok: false, reason: 'model', status: res.status, detail: `native ${model.provider} key rejected (401/403)`, check: { ...check, namespace: 'host', selectedServed: false } };
      }
      if (!res.ok) return { ok: false, reason: 'model', status: res.status, detail: `native ${model.provider} models endpoint answered ${res.status}`, check: { ...check, namespace: 'host', selectedServed: false } };
      ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
      check.served = ids.slice(0, 12);
      check.namespace = 'host';
      check.selectedServed = ids.includes(model.model);
    } else { // google
      const res = await get(`${model.endpoint}/v1beta/models?key=${encodeURIComponent(model.key)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await boundedJson(res).catch(() => null);
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: 'model', status: res.status, detail: 'native google key rejected (401/403)', check: { ...check, namespace: 'host', selectedServed: false } };
      }
      if (!res.ok) return { ok: false, reason: 'model', status: res.status, detail: `native google models endpoint answered ${res.status}`, check: { ...check, namespace: 'host', selectedServed: false } };
      ids = Array.isArray(body?.models) ? body.models.map((m) => m?.name).filter(Boolean) : [];
      check.served = ids.slice(0, 12);
      check.namespace = 'host';
      check.selectedServed = ids.some((id) => id === model.model || id === `models/${model.model}`);
    }
    if (!check.selectedServed) {
      return { ok: false, reason: 'model', detail: `selected model ${model.model} not in ${model.provider} list (set BOT_MODEL to the exact model id)`, check };
    }
    return { ok: true, check };
  } catch (error) {
    return { ok: false, reason: 'model', detail: `native ${model.provider} models list unreachable: ${error.message}`, check: { ...check, namespace: 'host', selectedServed: false } };
  }
}

// One FULL-tier pass: config -> health -> capabilities -> native auth/fleet
// -> model. Stops at the first failure. Whole-run budget enforced between
// steps (per-request timeouts bound each step). Intelligence entitlement
// is NOT probed here: it needs the pinned SDK, which the doctor CLI owns;
// the tracker reports it as unprobed and the doctor cache/CLI remains the
// entitlement authority (see docs/readiness-handshake-design.md §2.2).
export async function probeFullEvidence({
  env = process.env, fetchImpl = fetch, timeoutMs = PROBE_REQUEST_TIMEOUT_MS,
  budgetMs = FULL_PROBE_BUDGET_MS, identity = TRACKER_PROBE_IDENTITY,
  now = Date.now, namespaceFetchers = null, configValid = null,
} = {}) {
  const checks = { intelligence: { probed: false, source: 'doctor' } };
  if (configValid) {
    const cfg = configValid(env);
    if (!cfg.valid) return { live: false, reason: 'config', missing: cfg.missing, checks };
  }
  let base;
  try {
    base = upstreamServerBase(env);
  } catch (error) {
    return { live: false, reason: 'config', detail: error.message, checks };
  }
  const started = now();
  const overBudget = () => now() - started > budgetMs;
  const health = await probeUpstreamHealth({ base, fetchImpl, timeoutMs });
  checks.upstreamServer = { url: base, health: health.ok ? 'ok' : 'unreachable' };
  if (!health.ok) return { live: false, reason: health.reason, checks };
  if (overBudget()) return { live: false, reason: 'timeout', detail: 'full probe budget exceeded', checks };
  const caps = await probeCapabilities({ base, fetchImpl, timeoutMs });
  if (!caps.ok) return { live: false, reason: caps.reason, checks };
  checks.upstreamServer.capabilities = { mode: caps.mode, durableHistory: caps.durableHistory };
  if (overBudget()) return { live: false, reason: 'timeout', detail: 'full probe budget exceeded', checks };
  const auth = await probeNativeAuth({
    base, bridgeSecret: String(env.ME_HOME_BRIDGE_SECRET ?? '').trim(), fetchImpl, timeoutMs, identity,
  });
  checks.nativeAuth = auth.check ?? { probed: true };
  if (auth.check?.fleet) checks.fleet = auth.check.fleet;
  if (!auth.ok) return { live: false, reason: auth.reason, detail: auth.detail, checks };
  if (overBudget()) return { live: false, reason: 'timeout', detail: 'full probe budget exceeded', checks };
  const model = await probeModelServed({ env, fetchImpl, timeoutMs, namespaceFetchers });
  checks.model = model.check;
  if (!model.ok) return { live: false, reason: model.reason, detail: model.detail, checks };
  return { live: true, checks };
}
