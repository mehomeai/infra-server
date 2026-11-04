import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTracker, probeLiveEvidence, configFingerprint,
  LIVE_FULL_INTERVAL_MS, LIVE_FULL_TTL_MS,
} from '../src/upstream-live.mjs';
import { DOCTOR_CACHE_TTL_MS } from '../src/upstream-doctor.mjs';

const ENV = {
  ME_UPSTREAM_MODE: 'full',
  UPSTREAM_SERVER_URL: 'http://127.0.0.1:9',
  DATABASE_URL: 'postgres://u:p@h/db',
  KEY_ENCRYPTION_KEY: 'k'.repeat(44),
  ME_HOME_BRIDGE_SECRET: 'bridge-secret-0123456789abcdef-xyz',
  INTELLIGENCE_API_URL: 'https://i.example',
  INTELLIGENCE_GATEWAY_WS_URL: 'wss://i.example',
  CPK_INTELLIGENCE_API_KEY: 'k',
  BETTER_AUTH_URL: 'http://127.0.0.1:3001',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  INITIAL_ADMIN_EMAILS: 'a@example.com',
  COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
  SUPERVISOR_TOKEN: 's',
  COMPUTER_TOKEN: 'c',
  // Local Ollama route for the full-tier model proof; the harness surface
  // is served by the same fake fetch at ME_HARNESS_URL + /models.
  BOT_MODEL: 'llama3.1',
  OPENAI_BASE_URL: 'http://host.docker.internal:11434/v1',
  ME_HARNESS_URL: 'http://127.0.0.1:9',
};

function fakeRes(status, body) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

// Full-stack fake: light surface + fleet (role read from the assertion's
// role segment; HMAC itself is the upstream patch's job, not the probe's)
// + harness model surface + supervisor witness + host Ollama tags.
// `state` is mutable so a test can break one surface mid-flight.
export function fullFetch(state = {}) {
  const counts = {};
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    counts[path] = (counts[path] ?? 0) + 1;
    if (state.down) throw new Error('down');
    const assertion = init.headers?.['x-me-home-assertion'];
    const role = assertion ? String(assertion).split('.')[3] : null;
    if (path === '/health') return fakeRes(200, { status: 'ok' });
    if (path === '/api/capabilities') return fakeRes(200, { mode: 'intelligence', durableHistory: true });
    if (path === '/api/agents') {
      if (state.agentsStatus) return fakeRes(state.agentsStatus, {});
      return fakeRes(200, { agents: [{ id: 'bot_help' }] });
    }
    if (path === '/api/computers/fleet') {
      if (state.fleetGate) await state.fleetGate;
      if (role === 'admin') {
        if (state.fleetAdminStatus) return fakeRes(state.fleetAdminStatus, {});
        return fakeRes(200, { isolation: 'per-person', computers: [{ kind: 'person', personId: 'alice' }] });
      }
      return fakeRes(state.userFleetStatus ?? 403, {});
    }
    if (path === '/models') { // harness served-model view
      if (state.harnessDown) throw new Error('harness unreachable');
      return fakeRes(200, { data: (state.harnessModels ?? ['llama3.1']).map((id) => ({ id })) });
    }
    if (path === '/probe/model-tags') { // supervisor witness route
      if (!state.supervisorUp) throw new Error('no supervisor witness');
      return fakeRes(200, { models: (state.supervisorModels ?? ['llama3.1']).map((name) => ({ name })) });
    }
    if (path.endsWith('/api/tags')) { // host-side Ollama
      if (state.hostDown) throw new Error('host ollama unreachable');
      return fakeRes(200, { models: (state.hostModels ?? ['llama3.1']).map((name) => ({ name })) });
    }
    return fakeRes(404, {});
  };
  return { fetchImpl, counts };
}

function lightOkFetch() {
  return async (url) => {
    const t = String(url);
    const body = t.endsWith('/api/agents')
      ? { agents: [] }
      : t.endsWith('/api/capabilities')
        ? { mode: 'intelligence', durableHistory: true }
        : { status: 'ok' };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
  };
}

test('light probe succeeds on healthy stack, refuses config loss and bad auth', async () => {
  const ok = await probeLiveEvidence({ env: ENV, fetchImpl: lightOkFetch() });
  assert.deepEqual(ok, { live: true });
  const noCfg = await probeLiveEvidence({ env: { ...ENV, ME_HOME_BRIDGE_SECRET: '' }, fetchImpl: lightOkFetch() });
  assert.equal(noCfg.live, false);
  assert.equal(noCfg.reason, 'config');
  const down = await probeLiveEvidence({ env: ENV, fetchImpl: async () => { throw new Error('nope'); } });
  assert.deepEqual(down, { live: false, reason: 'unreachable' });
  const refused = await probeLiveEvidence({
    env: ENV,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/agents')) {
        return { ok: false, status: 401, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from('{}') };
      }
      return lightOkFetch()(url);
    },
  });
  assert.deepEqual(refused, { live: false, reason: 'auth' });
});

test('handshake windows: light 120s/300s, full 600s/900s', () => {
  assert.equal(LIVE_FULL_INTERVAL_MS, 600_000);
  assert.equal(LIVE_FULL_TTL_MS, 900_000);
  assert.equal(DOCTOR_CACHE_TTL_MS, 300_000);
});

test('tracker publishes live only after a full-tier pass; light alone cannot recover a fleet failure', async (t) => {
  const state = { userFleetStatus: 200 }; // isolation break: fleet answered to a user
  const { fetchImpl, counts } = fullFetch(state);
  const tracker = createLiveTracker({ env: ENV, fetchImpl });
  t.after(() => tracker.stop());
  assert.equal(tracker.get().live, false, 'boot is unproven');
  await tracker.refresh();
  assert.equal(tracker.get().live, false, 'light pass + fleet isolation break is NOT live');
  assert.equal(tracker.get().reason, 'fleet');
  assert.equal(tracker.getFull().ready, false);
  assert.equal(tracker.getFull().reason, 'fleet');
  // The light surface was healthy the whole time; only a full pass recovers.
  assert.ok(counts['/api/agents'] >= 2, 'both tiers probed agents');
  state.userFleetStatus = 403;
  await tracker.refresh();
  assert.equal(tracker.get().live, true, 'full-tier pass publishes live');
  assert.equal(tracker.getFull().ready, true);
  const full = tracker.getFull();
  assert.equal(full.checks.nativeAuth.roleGate, 'user-denied');
  assert.equal(full.checks.fleet.personKeys, 1);
  assert.equal(full.checks.model.selectedServed, true);
  assert.equal(full.checks.model.namespace, 'harness');
  assert.equal(full.checks.intelligence.probed, false);
  assert.equal(tracker.get().evidence.namespace, 'harness');
});

test('singleflight: concurrent refresh shares exactly one probe set per tier', async (t) => {
  const { fetchImpl, counts } = fullFetch();
  const tracker = createLiveTracker({ env: ENV, fetchImpl });
  t.after(() => tracker.stop());
  await Promise.all([tracker.refresh(), tracker.refresh(), tracker.refresh(), tracker.refresh(), tracker.refresh()]);
  assert.equal(tracker.get().live, true);
  assert.equal(counts['/api/computers/fleet'], 2, 'one full run = admin + user fleet reads');
  assert.equal(counts['/api/agents'], 2, 'one light + one full agents read');
  assert.equal(counts['/health'], 2, 'one light + one full health read');
  assert.equal(counts['/models'], 1, 'one harness model read');
});

test('per-tier TTL: light evidence goes stale at its TTL, full at its own', async (t) => {
  let now = 1_000_000;
  const a = fullFetch();
  const lightBound = createLiveTracker({
    env: ENV, fetchImpl: a.fetchImpl, ttlMs: 1_000, fullTtlMs: 100_000, now: () => now,
  });
  t.after(() => lightBound.stop());
  await lightBound.refresh();
  assert.equal(lightBound.get().live, true);
  now += 1_500; // past the 300s-equivalent light TTL (scaled), full still fresh
  assert.equal(lightBound.get().live, false);
  assert.equal(lightBound.get().reason, 'stale');

  now = 5_000_000;
  const b = fullFetch();
  const fullBound = createLiveTracker({
    env: ENV, fetchImpl: b.fetchImpl, ttlMs: 100_000, fullTtlMs: 2_000, now: () => now,
  });
  t.after(() => fullBound.stop());
  await fullBound.refresh();
  assert.equal(fullBound.get().live, true);
  now += 2_500; // past the 900s-equivalent full TTL (scaled), light still fresh
  assert.equal(fullBound.get().live, false);
  assert.equal(fullBound.get().reason, 'stale');
});

test('invalidation during an in-flight probe discards its result (generation)', async (t) => {
  let releaseFleet;
  const state = { fleetGate: new Promise((r) => { releaseFleet = r; }) };
  const { fetchImpl, counts } = fullFetch(state);
  const tracker = createLiveTracker({ env: ENV, fetchImpl });
  t.after(() => tracker.stop());
  const cycle = tracker.refresh();
  // Wait until the full tier is parked on the gated fleet read.
  for (let i = 0; i < 100 && !counts['/api/computers/fleet']; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(counts['/api/computers/fleet'] >= 1, 'full probe in flight');
  const genBefore = tracker.generation;
  tracker.invalidate('test');
  assert.equal(tracker.generation, genBefore + 1);
  assert.equal(tracker.get().live, false);
  assert.equal(tracker.get().reason, 'invalidated:test');
  releaseFleet();
  const settled = await cycle;
  assert.equal(settled.live, false, 'invalidated in-flight result is discarded, never published');
  // The kicked replacement probe re-proves and publishes.
  for (let i = 0; i < 100 && !tracker.get().live; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(tracker.get().live, true, 'replacement probe restores live');
});

test('config fingerprint: BOT_MODEL change invalidates and re-probes against the new config', async (t) => {
  const env = { ...ENV };
  const { fetchImpl } = fullFetch();
  const tracker = createLiveTracker({ env, fetchImpl });
  t.after(() => tracker.stop());
  await tracker.refresh();
  assert.equal(tracker.get().live, true);
  const fpBefore = configFingerprint(env);
  assert.equal(configFingerprint(env), fpBefore, 'fingerprint is stable for unchanged config');
  env.BOT_MODEL = 'other-model';
  assert.notEqual(configFingerprint(env), fpBefore, 'BOT_MODEL participates in the fingerprint');
  await tracker.refresh();
  assert.equal(tracker.get().live, false, 'old evidence does not carry over to a new model selection');
  assert.equal(tracker.get().reason, 'model', 're-probe ran against the new config and failed honestly');
});

test('model proof: host namespace alone never publishes READY; supervisor witness does', async (t) => {
  const hostOnly = fullFetch({ harnessDown: true }); // supervisor witness down too; host tags fine
  const a = createLiveTracker({ env: ENV, fetchImpl: hostOnly.fetchImpl });
  t.after(() => a.stop());
  await a.refresh();
  assert.equal(a.get().live, false, 'host-side tags alone must not publish readiness');
  assert.equal(a.get().reason, 'model');
  assert.equal(a.getFull().checks.model.namespace, 'host');
  assert.equal(a.getFull().checks.model.selectedServed, true, 'the model IS served host-side — the namespace is what fails');

  const witnessed = fullFetch({ harnessDown: true, supervisorUp: true });
  const b = createLiveTracker({ env: ENV, fetchImpl: witnessed.fetchImpl });
  t.after(() => b.stop());
  await b.refresh();
  assert.equal(b.get().live, true);
  assert.equal(b.getFull().checks.model.namespace, 'supervisor');
});

test('model proof: selected model missing from the harness view is not-live', async (t) => {
  const { fetchImpl } = fullFetch({ harnessModels: ['someone-else'] });
  const tracker = createLiveTracker({ env: ENV, fetchImpl });
  t.after(() => tracker.stop());
  await tracker.refresh();
  assert.equal(tracker.get().live, false);
  assert.equal(tracker.get().reason, 'model');
  assert.equal(tracker.getFull().checks.model.selectedServed, false);
  assert.equal(tracker.getFull().checks.model.namespace, 'harness');
});

test('tracker seeds from the on-disk cache and writes it back additively + atomically', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-live-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const cachePath = join(dir, 'doctor-cache.json');
  const { writeDoctorCache, readLiveEvidence } = await import('../src/upstream-doctor.mjs');
  const fs = await import('node:fs');
  writeDoctorCache(cachePath, { state: 'READY', checks: { mode: 'full' } }, { fs, at: 1_000_000, ttlMs: 300_000 });
  const { fetchImpl } = fullFetch();
  const seeded = createLiveTracker({ env: ENV, fetchImpl, now: () => 1_100_000, cachePath, fs });
  t.after(() => seeded.stop());
  assert.equal(seeded.get().live, true, 'restart seeds from last evidence (both tiers)');
  await seeded.refresh();
  assert.equal(seeded.get().live, true);
  const raw = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(raw.state, 'READY');
  assert.equal(raw.mode, 'full');
  assert.ok(raw.at >= 1_100_000);
  assert.equal(raw.tier, 'full', 'additive tier field written');
  assert.equal(typeof raw.generation, 'number', 'additive generation field written');
  assert.equal(readLiveEvidence(cachePath, { fs, at: 1_100_000 }).live, true, 'payload still round-trips the shared reader');
  assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.tmp')), 'atomic write leaves no torn file behind');
});

test('external doctor-cache change is observed: drift bumps generation and re-proves', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-live-drift-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const cachePath = join(dir, 'doctor-cache.json');
  const { writeDoctorCache } = await import('../src/upstream-doctor.mjs');
  const fs = await import('node:fs');
  const state = {};
  const { fetchImpl } = fullFetch(state);
  const tracker = createLiveTracker({ env: ENV, fetchImpl, cachePath, fs });
  t.after(() => tracker.stop());
  await tracker.refresh();
  assert.equal(tracker.get().live, true);
  const genBefore = tracker.generation;
  // A CLI doctor run lands a FAILED verdict in the shared cache file.
  writeDoctorCache(cachePath, { state: 'FAILED', checks: { mode: 'full' } }, { fs });
  state.down = true; // stack now down too: the re-probe must agree, not resurrect
  await tracker.refresh();
  assert.ok(tracker.generation > genBefore, 'external cache change invalidated tracker evidence');
  assert.equal(tracker.get().live, false);
  state.down = false;
  await tracker.refresh();
  assert.equal(tracker.get().live, true, 'healthy re-probe recovers after the external verdict ages out');
});

test('oversize cache file is refused, never trusted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-live-big-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const cachePath = join(dir, 'doctor-cache.json');
  await writeFile(cachePath, `{"protocol":"upstream-platform-v1","state":"READY","pad":"${'x'.repeat(5000)}"}`);
  const tracker = createLiveTracker({ env: ENV, fetchImpl: fullFetch().fetchImpl, cachePath });
  t.after(() => tracker.stop());
  assert.equal(tracker.get().live, false);
});
