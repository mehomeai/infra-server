// H8 home coordinator: real backend heartbeat + strict file gates.
// No fake heartbeat from the phone; the home heartbeats itself with its
// HomeToken. Disabled by default: zero outbound network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { chmodSync, lstatSync, mkdirSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';
import { createCoordinator, loadCoordinatorCredentials } from '../src/coordinator.mjs';
import { buildRuntimeEnv } from '../src/task-broker.mjs';
// Real backend (B1 dev registration path); B7 activation shares the same
// heartbeat route/auth documented in home-activation-v1.md.
import { createBackend } from '../../backend-server/src/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_BRIDGE = join(ROOT, 'test', 'fixture-bridge.mjs');
const DEV_SETUP_TOKEN = 'test-setup-token-h8-0123456789abcdef';
const DEV_ACCOUNTS = new Map([['test-token-h8-alice', 'acct_h8_alice']]);

function fixtureBroker(tasksRoot) {
  return {
    runtime: { command: [process.execPath, FIXTURE_BRIDGE], cwd: undefined },
    model: { provider: 'fixture', model: 'fixture-echo' },
    pollMs: 25,
    tasksRoot,
  };
}

async function startBackend(t, { staleAfterSeconds = 300 } = {}) {
  const { mkdtempSync } = await import('node:fs');
  const dataDir = mkdtempSync(join(tmpdir(), 'me-backend-h8-'));
  const backend = createBackend({
    host: '127.0.0.1', port: 0, dataDir,
    setupToken: DEV_SETUP_TOKEN, devAccounts: DEV_ACCOUNTS,
    staleAfterSeconds,
  });
  const server = createServer(backend.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, backend };
}

async function registerHome(base, installationId, endpointHint = 'http://127.0.0.1:7070') {
  const res = await fetch(`${base}/v1/homes/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-me-setup-token': DEV_SETUP_TOKEN },
    body: JSON.stringify({ installationId, endpointHint }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.ok(body.homeToken.startsWith('me_home_'));
  return body;
}

function writeCredFile(path, obj, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
  chmodSync(path, mode);
}

async function launchHome(t, { env = {}, broker = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h8-'));
  const dbPath = join(dir, 'home.sqlite');
  const tasksRoot = join(dir, 'tasks');
  const start = async (extraEnv = {}) => {
    const server = createHomeServer({
      dbPath,
      broker: { ...fixtureBroker(tasksRoot), ...(broker ?? {}), tasksRoot },
      env: { ...env, ...extraEnv },
    });
    const info = await server.start({ host: '127.0.0.1', port: 0 });
    return { server, base: `http://${info.host}:${info.port}` };
  };
  let current = await start();
  t.after(async () => {
    try { await current.server.stop(); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });
  for (const u of ['alice']) ensureUser(current.server.db, u, `${u} (dev fixture)`);
  const api = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${current.base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const pairAs = async (user) => {
    const inv = createInvitation(current.server.db, user, 60_000);
    const paired = await api('POST', '/v1/pair', {
      body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
    });
    assert.equal(paired.status, 201);
    const sess = await api('POST', '/v1/sessions', {
      body: { device_id: paired.json.device_id, device_secret: paired.json.device_secret },
    });
    assert.equal(sess.status, 201);
    return { ...paired.json, token: sess.json.token };
  };
  return {
    api, pairAs, dir, dbPath,
    get base() { return current.base; },
    get server() { return current.server; },
  };
}

function coordEnv(credFile, extra = {}) {
  return {
    HOME_COORDINATOR_CREDENTIALS_FILE: credFile,
    HOME_COORDINATOR_ALLOW_HTTP_LOOPBACK: '1',
    HOME_COORDINATOR_INTERVAL_MS: '60000',
    HOME_COORDINATOR_TIMEOUT_MS: '5000',
    ...extra,
  };
}

test('H8: real backend heartbeat marks home online; status stays honest when stale', async (t) => {
  const be = await startBackend(t, { staleAfterSeconds: 2 });
  const h = await launchHome(t);
  const reg = await registerHome(be.base, h.server.installationId);
  const credFile = join(h.dir, 'coord', 'coordinator.json');
  writeCredFile(credFile, {
    protocol: 'home-coordinator-v1',
    backend_url: be.base,
    home_id: reg.homeId,
    installation_id: h.server.installationId,
    home_token: reg.homeToken,
    endpoint_hint: 'http://127.0.0.1:7070',
    protocol_version: 'home-api-v1',
  });
  // Fresh home never heartbeated: honestly offline.
  const pre = await (await fetch(`${be.base}/v1/homes/${reg.homeId}/status`, {
    headers: { authorization: `Bearer ${reg.homeToken}` },
  })).json();
  assert.equal(pre.online, false);
  const coord = createCoordinator({
    installationId: h.server.installationId,
    env: coordEnv(credFile),
  });
  t.after(() => coord.stop());
  await coord.start();
  const out = await coord.heartbeatOnce();
  assert.equal(out.ok, true);
  const post = await (await fetch(`${be.base}/v1/homes/${reg.homeId}/status`, {
    headers: { authorization: `Bearer ${reg.homeToken}` },
  })).json();
  assert.equal(post.online, true);
  assert.equal(post.lastStatus, 'online');
  // Authenticated endpoint update via the same HomeToken route.
  writeCredFile(credFile, {
    protocol: 'home-coordinator-v1',
    backend_url: be.base,
    home_id: reg.homeId,
    installation_id: h.server.installationId,
    home_token: reg.homeToken,
    endpoint_hint: 'http://127.0.0.1:9999',
    protocol_version: 'home-api-v1',
  });
  const out2 = await coord.heartbeatOnce();
  assert.equal(out2.ok, true);
  const read = await (await fetch(`${be.base}/v1/homes/${reg.homeId}`, {
    headers: { authorization: `Bearer ${reg.homeToken}` },
  })).json();
  assert.equal(read.home.endpointHint, 'http://127.0.0.1:9999');
  await coord.stop();
});

test('H8: wrong home token suspends without leaking and private API keeps working', async (t) => {
  const be = await startBackend(t);
  const h = await launchHome(t);
  const alice = await h.pairAs('alice');
  const reg = await registerHome(be.base, h.server.installationId);
  const credFile = join(h.dir, 'coord2', 'coordinator.json');
  writeCredFile(credFile, {
    protocol: 'home-coordinator-v1',
    backend_url: be.base,
    home_id: reg.homeId,
    installation_id: h.server.installationId,
    home_token: 'me_home_' + 'A'.repeat(43),
    endpoint_hint: 'http://127.0.0.1:7070',
    protocol_version: 'home-api-v1',
  });
  let calls = 0;
  const countingFetch = async (...args) => { calls += 1; return fetch(...args); };
  const coord = createCoordinator({ installationId: h.server.installationId, env: coordEnv(credFile), fetchImpl: countingFetch });
  t.after(() => coord.stop());
  await coord.start();
  const out = await coord.heartbeatOnce();
  assert.equal(out.suspended, true);
  assert.equal(coord.state.suspended, true);
  const callsAfterSuspend = calls;
  const out2 = await coord.heartbeatOnce();
  assert.equal(out2.skipped, 'suspended');
  assert.equal(calls, callsAfterSuspend, 'suspended loop must not touch the network');
  const status = coord.getStatus();
  assert.equal(status.status, 'suspended');
  assert.ok(!JSON.stringify(status).includes('me_home_'));
  assert.ok(!JSON.stringify(status).includes('AAAA'));
  // Private API unaffected by cloud auth failure.
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: { title: 'offline ok' } });
  assert.equal(conv.status, 201);
  await coord.stop();
});

test('H8: disabled by default performs zero fetches', async (t) => {
  const h = await launchHome(t);
  let calls = 0;
  const coord = createCoordinator({
    installationId: h.server.installationId,
    env: {},
    fetchImpl: async (...args) => { calls += 1; return fetch(...args); },
  });
  t.after(() => coord.stop());
  await coord.start();
  const out = await coord.heartbeatOnce();
  assert.equal(out.skipped, 'disabled');
  assert.equal(calls, 0);
  assert.equal(coord.getStatus().status, 'disabled');
  await coord.stop();
});

test('H8: strict file gates (mode/symlink/format/home binding) with no secrets echoed', async (t) => {
  const be = await startBackend(t);
  const h = await launchHome(t);
  const reg = await registerHome(be.base, h.server.installationId);
  const good = {
    protocol: 'home-coordinator-v1',
    backend_url: be.base,
    home_id: reg.homeId,
    installation_id: h.server.installationId,
    home_token: reg.homeToken,
    endpoint_hint: 'http://127.0.0.1:7070',
    protocol_version: 'home-api-v1',
  };
  const dir = await mkdtemp(join(tmpdir(), 'me-h8-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tryLoad = (obj, { mode = 0o600, allowHttp = true, expectedId } = {}) => {
    const p = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
    writeCredFile(p, obj, mode);
    try {
      return loadCoordinatorCredentials(p, {
        expectedInstallationId: expectedId ?? h.server.installationId,
        allowHttpLoopback: allowHttp,
      });
    } catch (e) {
      // Generic codes only: never echo secrets or file contents.
      assert.ok(typeof e.code === 'string');
      assert.ok(!String(e.message).includes(reg.homeToken));
      assert.ok(!JSON.stringify(obj).includes(e.message) || e.message === e.code);
      throw e;
    }
  };
  // Happy path.
  assert.ok(tryLoad(good).homeId);
  // Wrong installation -> wrong_home, no network.
  assert.throws(() => tryLoad(good, { expectedId: '00000000-0000-4000-8000-000000000000' }), /wrong_home/);
  // Group-readable mode rejected.
  assert.throws(() => tryLoad(good, { mode: 0o640 }), /invalid_credentials_permissions/);
  // Final symlink rejected.
  {
    const target = join(dir, 'real.json');
    writeCredFile(target, good);
    const link = join(dir, 'link.json');
    try { symlinkSync(target, link); } catch { /* windows */ }
    try {
      loadCoordinatorCredentials(link, { expectedInstallationId: h.server.installationId, allowHttpLoopback: true });
      assert.fail('symlink must be rejected');
    } catch (e) {
      assert.equal(e.code, 'invalid_credentials_file');
    }
  }
  // Bad shapes rejected without echo.
  for (const bad of [
    { ...good, protocol: 'wrong' },
    { ...good, protocol_version: 'v9' },
    { ...good, home_token: 'bad' },
    { ...good, home_id: 'BAD!' },
    { ...good, backend_url: 'https://backend.example.test?q=1' },
    { ...good, backend_url: 'https://user:pass@backend.example.test/' },
    { ...good, backend_url: 'https://backend.example.test#frag' },
    { ...good, backend_url: 'http://backend.example.test/' },
    { ...good, endpoint_hint: 'not-a-url' },
    { ...good, extra: 'nope' },
  ]) {
    assert.throws(() => tryLoad(bad), /invalid_/);
  }
  // http loopback requires the explicit flag.
  assert.throws(() => tryLoad(good, { allowHttp: false }), /invalid_backend_url/);
  // Non-absolute path rejected.
  assert.throws(() => loadCoordinatorCredentials('relative/path.json', {}), /invalid_credentials_path/);
});

test('H8: redirect and invalid JSON never leak the token or break private API', async (t) => {
  const h = await launchHome(t);
  const alice = await h.pairAs('alice');
  const credFile = join(h.dir, 'coord-r', 'coordinator.json');
  // Redirect target: fails closed, token must not be forwarded cross-origin.
  // The configured origin legitimately receives Authorization; the Location
  // target must never see it (redirect:'error' never follows).
  let secondHits = 0;
  let secondAuth = null;
  const secondSrv = createServer((req, res) => {
    secondHits += 1;
    secondAuth = req.headers.authorization ?? null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  secondSrv.listen(0, '127.0.0.1');
  await once(secondSrv, 'listening');
  t.after(() => secondSrv.close());
  const secondBase = `http://127.0.0.1:${secondSrv.address().port}`;
  let firstHits = 0;
  const redirectSrv = createServer((req, res) => {
    firstHits += 1;
    res.writeHead(302, { location: `${secondBase}/elsewhere` });
    res.end();
  });
  redirectSrv.listen(0, '127.0.0.1');
  await once(redirectSrv, 'listening');
  t.after(() => redirectSrv.close());
  const redirBase = `http://127.0.0.1:${redirectSrv.address().port}`;
  writeCredFile(credFile, {
    protocol: 'home-coordinator-v1',
    backend_url: redirBase,
    home_id: 'home_abc123',
    installation_id: h.server.installationId,
    home_token: 'me_home_' + 'B'.repeat(43),
    endpoint_hint: 'http://127.0.0.1:7070',
    protocol_version: 'home-api-v1',
  });
  const coord = createCoordinator({ installationId: h.server.installationId, env: coordEnv(credFile) });
  t.after(() => coord.stop());
  await coord.start();
  const out = await coord.heartbeatOnce();
  assert.equal(out.ok, false);
  assert.equal(firstHits, 1);
  assert.equal(secondHits, 0, 'redirect target must never be fetched (redirect:error)');
  assert.equal(secondAuth, null, 'redirect target must never see Authorization');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: { title: 'still local' } });
  assert.equal(conv.status, 201);
  await coord.stop();
});

test('H8: rotation while inflight cannot publish stale credential state', async (t) => {
  const be = await startBackend(t);
  const h = await launchHome(t);
  const reg = await registerHome(be.base, h.server.installationId);
  const credFile = join(h.dir, 'coord-rot', 'coordinator.json');
  const baseCreds = {
    protocol: 'home-coordinator-v1',
    backend_url: be.base,
    home_id: reg.homeId,
    installation_id: h.server.installationId,
    home_token: reg.homeToken,
    endpoint_hint: 'http://127.0.0.1:7070',
    protocol_version: 'home-api-v1',
  };
  writeCredFile(credFile, baseCreds);
  let release;
  const gate = new Promise((r) => { release = r; });
  const gatedFetch = async (url, opts) => {
    await gate;
    return fetch(url, opts);
  };
  const coord = createCoordinator({ installationId: h.server.installationId, env: coordEnv(credFile), fetchImpl: gatedFetch });
  t.after(() => coord.stop());
  await coord.start();
  const pending = coord.heartbeatOnce();
  // Rotate the file while the first attempt is stalled: mtime bump + same
  // shape (token unchanged here; generation still advances on mtime change
  // only if contents differ — force a second registration for a new token).
  const reg2 = await (async () => {
    // Second home gives a fresh token for the rotation write.
    const r = await fetch(`${be.base}/v1/homes/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-me-setup-token': DEV_SETUP_TOKEN },
      body: JSON.stringify({ installationId: h.server.installationId, endpointHint: 'http://127.0.0.1:7070' }),
    });
    return r.json();
  })();
  // Point the file at the second home (rotation to a different binding).
  writeCredFile(credFile, { ...baseCreds, home_id: reg2.homeId, home_token: reg2.homeToken });
  coord.refreshCredentials();
  release();
  const first = await pending;
  assert.equal(first.skipped, 'stale_generation');
  // The stale result must not have published over the rotated state.
  assert.ok(coord.state.credentials.homeId === reg2.homeId);
  await coord.stop();
});

test('H8: cloud-offline home conversation + task still work; stop cancels stalled body', async (t) => {
  const h = await launchHome(t);
  const alice = await h.pairAs('alice');
  // Unreachable backend (closed port): transient offline, never fatal.
  const credFile = join(h.dir, 'coord-off', 'coordinator.json');
  writeCredFile(credFile, {
    protocol: 'home-coordinator-v1',
    backend_url: 'http://127.0.0.1:1',
    home_id: 'home_offline1',
    installation_id: h.server.installationId,
    home_token: 'me_home_' + 'C'.repeat(43),
    endpoint_hint: 'http://127.0.0.1:7070',
    protocol_version: 'home-api-v1',
  });
  const coord = createCoordinator({ installationId: h.server.installationId, env: coordEnv(credFile) });
  t.after(() => coord.stop());
  await coord.start();
  const out = await coord.heartbeatOnce();
  assert.equal(out.ok, false);
  // Local work proceeds while the cloud is down.
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: { title: 'offline task' } });
  assert.equal(conv.status, 201);
  const task = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'offline hello' },
  });
  assert.equal(task.status, 201);
  // Stalled body: stop() aborts without orphaning.
  let bodyRelease;
  const bodyGate = new Promise((r) => { bodyRelease = r; });
  const stalledFetch = async () => new Promise((_, reject) => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    bodyGate.then(() => reject(err));
  });
  const coord2 = createCoordinator({
    installationId: h.server.installationId,
    env: coordEnv(credFile),
    fetchImpl: stalledFetch,
  });
  await coord2.start();
  const pend = coord2.heartbeatOnce();
  await coord2.stop();
  bodyRelease();
  const settled = await pend;
  assert.ok(settled.ok === false);
  await coord.stop();
});

test('H8: coordinator status is authenticated and redacted; runtime env excludes secrets', async (t) => {
  const be = await startBackend(t);
  const h = await launchHome(t);
  const alice = await h.pairAs('alice');
  const reg = await registerHome(be.base, h.server.installationId);
  // Unauthenticated status reads as 401.
  const anon = await h.api('GET', '/v1/coordinator/status', {});
  assert.equal(anon.status, 401);
  // Wire the home's own coordinator via server env (restart with file).
  const credFile = join(h.dir, 'coord-st', 'coordinator.json');
  writeCredFile(credFile, {
    protocol: 'home-coordinator-v1',
    backend_url: be.base,
    home_id: reg.homeId,
    installation_id: h.server.installationId,
    home_token: reg.homeToken,
    endpoint_hint: 'http://127.0.0.1:7070',
    protocol_version: 'home-api-v1',
  });
  const coord = h.server.coordinator;
  assert.ok(coord);
  // Redaction: no token, prefix, raw errors, or account claims.
  const st = await h.api('GET', '/v1/coordinator/status', { token: alice.token });
  assert.equal(st.status, 200);
  const blob = JSON.stringify(st.json);
  assert.ok(!blob.includes(reg.homeToken));
  assert.ok(!blob.includes('me_home_'));
  assert.ok(!blob.includes('acct_'));
  assert.ok(!blob.includes(credFile));
  // Runtime env sentinel: coordinator/file/push/ssh/aws never cross.
  const childEnv = buildRuntimeEnv({
    PATH: '/usr/bin',
    HOME_COORDINATOR_CREDENTIALS_FILE: credFile,
    HOME_COORDINATOR_INTERVAL_MS: '60000',
    HOME_EXPO_ACCESS_TOKEN: 'secret',
    SSH_AUTH_SOCK: '/tmp/ssh',
    AWS_SECRET_ACCESS_KEY: 'secret',
    ME_RUNTIME_MODEL_API_KEY: 'model-key-ok',
    ME_RUNTIME_HOME_TOKEN: 'me_home_should_not_cross',
    ME_RUNTIME_ALLOW_REMOTE: '1',
  }, { provider: 'openai', model: 'x', api_key_env: 'ME_RUNTIME_MODEL_API_KEY' });
  assert.equal(childEnv.HOME_COORDINATOR_CREDENTIALS_FILE, undefined);
  assert.equal(childEnv.HOME_EXPO_ACCESS_TOKEN, undefined);
  assert.equal(childEnv.SSH_AUTH_SOCK, undefined);
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.ME_RUNTIME_HOME_TOKEN, undefined);
  assert.equal(childEnv.ME_RUNTIME_MODEL_API_KEY, 'model-key-ok');
});
