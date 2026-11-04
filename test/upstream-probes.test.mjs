import assert from 'node:assert/strict';
import test from 'node:test';
import {
  probeNativeAuth, probeModelServed, probeFullEvidence,
} from '../src/upstream-probes.mjs';

const SECRET = 'bridge-secret-0123456789abcdef-xyz';
const BASE = 'http://127.0.0.1:9';

const ENV = {
  UPSTREAM_SERVER_URL: BASE,
  DATABASE_URL: 'postgres://u:p@h/db',
  KEY_ENCRYPTION_KEY: 'k'.repeat(44),
  ME_HOME_BRIDGE_SECRET: SECRET,
  INTELLIGENCE_API_URL: 'https://i.example',
  INTELLIGENCE_GATEWAY_WS_URL: 'wss://i.example',
  CPK_INTELLIGENCE_API_KEY: 'k',
  BETTER_AUTH_URL: 'http://127.0.0.1:3001',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  INITIAL_ADMIN_EMAILS: 'a@example.com',
  COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
  SUPERVISOR_TOKEN: 's',
  COMPUTER_TOKEN: 'c',
  BOT_MODEL: 'llama3.1',
  OPENAI_BASE_URL: 'http://host.docker.internal:11434/v1',
};

function fakeRes(status, body) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

function stackFetch(state = {}) {
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const assertion = init.headers?.['x-me-home-assertion'];
    const role = assertion ? String(assertion).split('.')[3] : null;
    if (path === '/health') return fakeRes(200, { status: 'ok' });
    if (path === '/api/capabilities') return fakeRes(200, { mode: 'intelligence', durableHistory: true });
    if (path === '/api/agents') {
      if (state.agentsStatus) return fakeRes(state.agentsStatus, {});
      return fakeRes(200, { agents: [{ id: 'a' }, { id: 'b' }] });
    }
    if (path === '/api/computers/fleet') {
      if (role === 'admin') {
        if (state.fleetAdminStatus) return fakeRes(state.fleetAdminStatus, {});
        return fakeRes(200, state.fleetBody ?? { isolation: 'per-person', computers: [{ kind: 'person', personId: 'alice' }, { kind: 'bot' }] });
      }
      return fakeRes(state.userFleetStatus ?? 403, {});
    }
    if (path === '/models') return fakeRes(200, { data: [{ id: 'llama3.1' }] });
    return fakeRes(404, {});
  };
}

test('probeNativeAuth: healthy fleet + role gate pass with per-person evidence', async () => {
  const out = await probeNativeAuth({ base: BASE, bridgeSecret: SECRET, fetchImpl: stackFetch() });
  assert.equal(out.ok, true);
  assert.equal(out.check.authenticated, true);
  assert.equal(out.check.agents, 2);
  assert.equal(out.check.fleet.computers, 2);
  assert.equal(out.check.fleet.personKeys, 1, 'only the person-keyed computer counts');
  assert.equal(out.check.roleGate, 'user-denied');
  assert.equal(out.check.perPerson, true);
});

test('probeNativeAuth: 401 on agents is an auth failure; user fleet success is a fleet failure', async () => {
  const refused = await probeNativeAuth({ base: BASE, bridgeSecret: SECRET, fetchImpl: stackFetch({ agentsStatus: 401 }) });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'auth');
  const open = await probeNativeAuth({ base: BASE, bridgeSecret: SECRET, fetchImpl: stackFetch({ userFleetStatus: 200 }) });
  assert.equal(open.ok, false);
  assert.equal(open.reason, 'fleet');
  const shapeless = await probeNativeAuth({ base: BASE, bridgeSecret: SECRET, fetchImpl: stackFetch({ fleetBody: { computers: 'nope' } }) });
  assert.equal(shapeless.ok, false);
  assert.equal(shapeless.reason, 'fleet');
  const noSecret = await probeNativeAuth({ base: BASE, bridgeSecret: '', fetchImpl: stackFetch() });
  assert.equal(noSecret.reason, 'config');
});

test('probeModelServed: a namespace that answers is definitive — no fall-through to weaker proofs', async () => {
  let supervisorCalled = false;
  const out = await probeModelServed({
    env: ENV,
    fetchImpl: async () => { throw new Error('host must not be consulted after a harness answer'); },
    namespaceFetchers: [
      { namespace: 'harness', fetchNames: async () => ['other-model'] },
      { namespace: 'supervisor', fetchNames: async () => { supervisorCalled = true; return ['llama3.1']; } },
      { namespace: 'host', fetchNames: null },
    ],
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'model');
  assert.equal(out.check.namespace, 'harness');
  assert.equal(out.check.selectedServed, false);
  assert.equal(supervisorCalled, false, 'harness answered; weaker namespaces are not consulted');
});

test('probeModelServed: unreachable harness falls back to the supervisor witness, then host', async () => {
  const witnessed = await probeModelServed({
    env: ENV,
    fetchImpl: async () => { throw new Error('unused'); },
    namespaceFetchers: [
      { namespace: 'harness', fetchNames: async () => { throw new Error('down'); } },
      { namespace: 'supervisor', fetchNames: async () => ['llama3.1'] },
      { namespace: 'host', fetchNames: null },
    ],
  });
  assert.equal(witnessed.ok, true);
  assert.equal(witnessed.check.namespace, 'supervisor');
  assert.equal(witnessed.check.containerProven, true);

  const hostOnly = await probeModelServed({
    env: ENV,
    fetchImpl: async (url) => {
      assert.ok(String(url).endsWith('/api/tags'));
      return fakeRes(200, { models: [{ name: 'llama3.1' }] });
    },
    namespaceFetchers: [
      { namespace: 'harness', fetchNames: async () => null },
      { namespace: 'host', fetchNames: null },
    ],
  });
  assert.equal(hostOnly.ok, false, 'host proof alone is never READY for the local route');
  assert.equal(hostOnly.check.namespace, 'host');
  assert.equal(hostOnly.check.selectedServed, true);
  assert.equal(hostOnly.check.containerProven, false);
});

test('probeModelServed: remote route uses the provider list and does not namespace-gate', async () => {
  const env = { ...ENV, OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', OPENAI_API_KEY: 'sk-test', BOT_MODEL: 'gpt-5.5' };
  const out = await probeModelServed({
    env,
    fetchImpl: async (url, init) => {
      assert.equal(new URL(String(url)).pathname, '/v1/models');
      assert.equal(init.headers.authorization, 'Bearer sk-test');
      return fakeRes(200, { data: [{ id: 'gpt-5.5' }] });
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.check.namespace, 'host');
  assert.equal(out.check.selectedServed, true);
  const noKey = await probeModelServed({ env: { ...env, OPENAI_API_KEY: '' }, fetchImpl: async () => { throw new Error('unused'); } });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.reason, 'model');
});

test('probeFullEvidence: config gate, healthy pass, and whole-run budget', async () => {
  const { liveConfig } = await import('../src/upstream-live.mjs');
  const missing = await probeFullEvidence({ env: { ...ENV, ME_HOME_BRIDGE_SECRET: '' }, fetchImpl: stackFetch(), configValid: liveConfig });
  assert.equal(missing.live, false);
  assert.equal(missing.reason, 'config');

  const healthy = await probeFullEvidence({
    env: { ...ENV, ME_HARNESS_URL: BASE }, fetchImpl: stackFetch(), configValid: liveConfig,
  });
  assert.equal(healthy.live, true);
  assert.equal(healthy.checks.nativeAuth.roleGate, 'user-denied');
  assert.equal(healthy.checks.fleet.personKeys, 1);
  assert.equal(healthy.checks.model.namespace, 'harness');
  assert.equal(healthy.checks.intelligence.probed, false);

  let tick = 0;
  const budgeted = await probeFullEvidence({
    env: { ...ENV, ME_HARNESS_URL: BASE },
    fetchImpl: stackFetch(),
    configValid: liveConfig,
    budgetMs: 30_000,
    now: () => (tick++ === 0 ? 0 : 999_999),
  });
  assert.equal(budgeted.live, false);
  assert.equal(budgeted.reason, 'timeout');
});
