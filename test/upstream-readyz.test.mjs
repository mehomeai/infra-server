import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHomeServer } from '../src/server.mjs';

// Contract test for the readiness handshake consumer surface (OPEN #4):
// /readyz stays storage-only; /readyz/full answers from the two-tier
// evidence; /healthz gains the additive evidence fields in FULL mode.

const BRIDGE_SECRET = 'test-bridge-secret-0123456789abcdef-xyz';

const FULL_ENV = {
  ME_UPSTREAM_MODE: 'full',
  UPSTREAM_SERVER_URL: 'http://127.0.0.1:9',
  DATABASE_URL: 'postgres://openbot:x@postgres:5432/openbot',
  KEY_ENCRYPTION_KEY: 'k'.repeat(44),
  ME_HOME_BRIDGE_SECRET: BRIDGE_SECRET,
  INTELLIGENCE_API_URL: 'https://intel.home.example',
  INTELLIGENCE_GATEWAY_WS_URL: 'wss://intel.home.example',
  CPK_INTELLIGENCE_API_KEY: 'k',
  BETTER_AUTH_URL: 'http://127.0.0.1:3001',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  INITIAL_ADMIN_EMAILS: 'alice@example.com',
  COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
  SUPERVISOR_TOKEN: 's',
  COMPUTER_TOKEN: 'c',
  BOT_MODEL: 'gpt-5.5',
  OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
  OPENAI_API_KEY: 'test-openai-key',
};

function fakeRes(status, body) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

test('GET /readyz/full: 503 until the full tier passes, then 200 with checks; /readyz unchanged', async (t) => {
  const state = { userFleetStatus: 403 };
  const upstreamFetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const assertion = init.headers?.['x-me-home-assertion'];
    const role = assertion ? String(assertion).split('.')[3] : null;
    if (path === '/health') return fakeRes(200, { status: 'ok' });
    if (path === '/api/capabilities') return fakeRes(200, { mode: 'intelligence', durableHistory: true });
    if (path === '/api/agents') return fakeRes(200, { agents: [{ id: 'bot_help' }] });
    if (path === '/api/computers/fleet') {
      if (role === 'admin') return fakeRes(200, { isolation: 'per-person', computers: [{ kind: 'person', personId: 'alice' }] });
      return fakeRes(state.userFleetStatus, {});
    }
    if (path === '/v1/models') return fakeRes(200, { data: [{ id: 'gpt-5.5' }] });
    return fakeRes(404, {});
  };
  const dir = await mkdtemp(join(tmpdir(), 'me-readyz-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const server = createHomeServer({
    dbPath: join(dir, 'home.sqlite'),
    env: { ...process.env, ...FULL_ENV },
    upstreamFetch,
    liveIntervalMs: 25,
    liveFullIntervalMs: 50,
  });
  const { host, port } = await server.start({ host: '127.0.0.1', port: 0 });
  t.after(async () => { try { await server.stop(); } catch { /* already stopped */ } });
  const base = `http://${host}:${port}`;
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: await res.json() };
  };
  const pollUntil = async (path, want, guard = 120) => {
    let out = await get(path);
    while (out.status !== want && guard-- > 0) {
      await new Promise((r) => setTimeout(r, 25));
      out = await get(path);
    }
    return out;
  };

  // Storage-only /readyz is ready immediately, full or not.
  const rz = await get('/readyz');
  assert.equal(rz.status, 200);
  assert.equal(rz.json.ready, true);

  const full = await pollUntil('/readyz/full', 200);
  assert.equal(full.status, 200, 'full tier passes against the healthy fake stack');
  assert.equal(full.json.ready, true);
  assert.equal(typeof full.json.at, 'number');
  assert.equal(full.json.checks.nativeAuth.roleGate, 'user-denied');
  assert.equal(full.json.checks.fleet.personKeys, 1);
  assert.equal(full.json.checks.model.selectedServed, true);
  assert.equal(full.json.checks.model.namespace, 'host', 'remote provider route: doctor list proof, no namespace gate');
  assert.equal(full.json.checks.intelligence.probed, false);

  const hz = await get('/healthz');
  assert.equal(hz.status, 200);
  assert.equal(hz.json.fullConfigured, true);
  assert.equal(hz.json.evidence.tier, 'full');
  assert.equal(hz.json.evidence.namespace, 'host');
  assert.equal(typeof hz.json.evidence.at, 'number');

  // Break the role gate: readiness must fall on the next full cycle while
  // storage-only /readyz stays up. (The tracker interval clamps to 1s, so
  // allow a few seconds for the re-probe cycle.)
  state.userFleetStatus = 200;
  const broken = await pollUntil('/readyz/full', 503, 240);
  assert.equal(broken.status, 503);
  assert.equal(broken.json.ready, false);
  assert.equal(broken.json.reason, 'fleet');
  assert.ok(broken.json.checks, 'failing checks ride along for diagnosis');
  const rz2 = await get('/readyz');
  assert.equal(rz2.status, 200, '/readyz keeps its storage-only meaning');
});
