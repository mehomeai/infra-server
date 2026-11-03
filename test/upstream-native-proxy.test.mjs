import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';

// Full HTTP-boundary proof for the native upstream integration:
// real Me pairing/sessions -> real server proxy -> stub upstream that
// enforces the SAME contract as vendor patch server/src/home-bridge.ts
// (HMAC assertion, owner scoping, no cookie/shared-admin trust).
// The verifier below is TEST-ONLY; production verification lives in the
// vendored patch + upstream-identity mapping.

const BRIDGE_SECRET = 'test-bridge-secret-0123456789abcdef-xyz';

function testVerifyAssertion(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 6) return null;
  const [version, userId, expRaw, role, nonceHex, mac] = parts;
  if (version !== 'v2') return null;
  if (!userId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(userId)) return null;
  if (!/^[0-9a-f]{32}$/.test(nonceHex ?? '')) return null;
  if (role !== 'admin' && role !== 'user') return null;
  if (!(Number(expRaw) > Date.now())) return null;
  const expected = createHmac('sha256', BRIDGE_SECRET).update(`${version}.${userId}.${expRaw}.${role}.${nonceHex}`).digest();
  let actual;
  try { actual = Buffer.from(mac, 'hex'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { userId, role };
}

function fakeRes(status, body, extraHeaders = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key in extraHeaders) return extraHeaders[key];
        return key === 'content-type' && text ? 'application/json' : null;
      },
    },
    json: async () => (text ? JSON.parse(text) : null),
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text),
  };
}

// Minimal upstream native surface per the pinned delivery/channels/agents
// routes: assertion-guarded roster, channels, delivery conversations/history,
// owner-scoped (ownedScope semantics), strict message shape.
function createFakeUpstream() {
  const channels = new Map();
  const messages = new Map();
  const seen = [];
  let n = 0;
  const principalOf = (headers) => {
    if (headers.authorization || headers.cookie) {
      return { error: 'phone credentials must never reach upstream' };
    }
    const p = testVerifyAssertion(headers['x-me-home-assertion']);
    if (!p) return { error: 'invalid or missing home assertion' };
    return { principal: p };
  };
  return {
    seen,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const path = u.pathname;
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = init.headers ?? {};
      const asserted = testVerifyAssertion(headers['x-me-home-assertion']);
      seen.push({ method, path, assertionPresent: Boolean(headers['x-me-home-assertion']), assertionRole: asserted?.role ?? null, assertionUser: asserted?.userId ?? null });
      // Anonymous surface (mirrors upstream app.ts: /health + /api/capabilities
      // answer without a session). Everything else requires the assertion.
      const anonymous = method === 'GET' && (path === '/health' || path === '/api/capabilities');
      let me = null;
      if (!anonymous) {
        const gate = principalOf(headers);
        if (gate.error) return fakeRes(401, { error: gate.error });
        me = gate.principal;
      }
      const body = init.body ? JSON.parse(init.body.toString()) : undefined;
      if (method === 'GET' && path === '/api/agents') {
        return fakeRes(200, { agents: [{ id: 'bot_help', name: 'Helper', mine: true, canManage: true }] }, { 'set-cookie': 'upstream-session=abc; Path=/; HttpOnly' });
      }
      if (method === 'GET' && (path === '/health' || path === '/api/health')) {
        return fakeRes(200, { status: 'ok' });
      }
      if (method === 'GET' && path === '/api/capabilities') {
        return fakeRes(200, { mode: 'intelligence', durableHistory: true });
      }
      if (method === 'POST' && path === '/api/channels/') {
        if (!Array.isArray(body?.agentIds) || body.agentIds.length === 0 || body.agentIds.some((a) => a !== 'bot_help')) {
          return fakeRes(400, { error: 'Supply a valid request.' });
        }
        const id = `ch_${++n}`;
        const channel = { id, name: 'Chat', agentIds: body.agentIds, active: true };
        channels.set(id, { ...channel, owner: me.userId });
        messages.set(id, []);
        return fakeRes(201, { channel });
      }
      if (method === 'GET' && path === '/api/channels/') {
        const owned = [...channels.values()].filter((c) => c.owner === me.userId)
          .map(({ owner, ...c }) => c);
        return fakeRes(200, { channels: owned, nextCursor: null });
      }
      const chGet = path.match(/^\/api\/channels\/([^/]+)$/);
      if (method === 'GET' && chGet) {
        const c = channels.get(chGet[1]);
        if (!c || c.owner !== me.userId) return fakeRes(404, { error: "Couldn't find that conversation." });
        const { owner, ...rest } = c;
        return fakeRes(200, { channel: rest });
      }
      if (method === 'GET' && path === '/api/delivery/conversations') {
        const owned = [...channels.values()].filter((c) => c.owner === me.userId);
        return fakeRes(200, { conversations: owned.map(({ owner, ...c }) => c), nextCursor: null });
      }
      const hist = path.match(/^\/api\/delivery\/conversations\/([^/]+)\/history$/);
      if (method === 'GET' && hist) {
        const c = channels.get(hist[1]);
        const agentId = u.searchParams.get('agentId');
        if (!c || c.owner !== me.userId || !c.agentIds.includes(agentId)) {
          return fakeRes(400, { error: 'Choose an accessible Bot in your conversation.' });
        }
        return fakeRes(200, { history: messages.get(hist[1]) ?? [] });
      }
      const msg = path.match(/^\/api\/delivery\/conversations\/([^/]+)\/messages$/);
      if (method === 'POST' && msg) {
        const c = channels.get(msg[1]);
        const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.externalId ?? '');
        if (!c || c.owner !== me.userId || body?.agentId == null || !c.agentIds.includes(body.agentId)) {
          return fakeRes(400, { error: 'Choose an accessible Bot in your conversation.' });
        }
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000 || !uuidOk) {
          return fakeRes(400, { error: 'Supply a valid request.' });
        }
        messages.get(msg[1]).push({ role: 'user', content: body.text });
        return fakeRes(202, { accepted: true, externalId: body.externalId });
      }
      return fakeRes(404, { error: 'not found' });
    },
  };
}

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
  ME_UPSTREAM_ADMIN_USERS: 'alice',
  COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
  SUPERVISOR_TOKEN: 's',
  COMPUTER_TOKEN: 'c',
};

async function launch(t, { env = FULL_ENV, fake = 'healthy', liveIntervalMs = 120_000, liveTtlMs = null, liveKick = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-native-proxy-'));
  const dbPath = join(dir, 'home.sqlite');
  const upstream = createFakeUpstream();
  const fetchImpl = fake === 'unhealthy'
    ? async () => ({ status: 404, ok: false, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from('{}') })
    : upstream.fetch;
  const boot = async () => {
    const s = createHomeServer({
      dbPath,
      env: { ...process.env, ...env },
      upstreamFetch: fetchImpl,
      liveIntervalMs,
      ...(liveTtlMs == null ? {} : { liveTtlMs }),
      liveKick,
    });
    const i = await s.start({ host: '127.0.0.1', port: 0 });
    for (const u of ['alice', 'bob']) ensureUser(s.db, u, u);
    return { server: s, base: `http://${i.host}:${i.port}` };
  };
  let current = await boot();
  t.after(async () => {
    try { await current.server.stop(); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });
  const restart = async () => {
    try { await current.server.stop(); } catch { /* already stopped */ }
    current = await boot();
  };
  const baseOf = () => current.base;
  const serverOf = () => current.server;
  const api = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${baseOf()}${path}`, {
      method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON relay */ }
    return { status: res.status, json, text };
  };
  const pairAs = async (user) => {
    const inv = createInvitation(serverOf().db, user, 60_000);
    const paired = await api('POST', '/v1/pair', {
      body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
    });
    assert.equal(paired.status, 201);
    const sess = await api('POST', '/v1/sessions', {
      body: { device_id: paired.json.device_id, device_secret: paired.json.device_secret },
    });
    assert.equal(sess.status, 201);
    return sess.json.token;
  };
  return { api, pairAs, fake: upstream, restart, get server() { return serverOf(); }, get base() { return baseOf(); }, get dbPath() { return dbPath; } };
}

test('capability report is additive and leak-free on /healthz and /v1/me', async (t) => {
  // Unhealthy upstream: env-complete but no live evidence => setup-needed.
  const down = await launch(t, { fake: 'unhealthy' });
  const bare = await down.api('GET', '/healthz');
  assert.equal(bare.status, 200);
  assert.equal(bare.json.agentMode, 'full-upstream');
  assert.equal(bare.json.configValid, true);
  assert.equal(bare.json.fullConfigured, false, 'env presence alone is not configured');
  assert.equal(bare.json.needsSetup, true);
  assert.ok((bare.json.missing ?? []).includes('live-doctor-evidence'));
  // Healthy upstream: the background tracker proves liveness and the
  // capability route reflects it without awaiting the network.
  const h = await launch(t, { liveIntervalMs: 25 });
  const health = await h.api('GET', '/healthz');
  let guard = 0;
  let live = health.json;
  while (!live.fullConfigured && guard++ < 100) {
    await new Promise((r) => setTimeout(r, 25));
    live = (await h.api('GET', '/healthz')).json;
  }
  assert.equal(live.fullConfigured, true);
  assert.deepEqual(live.transports, ['native-rest']);
  assert.ok(Array.isArray(live.nativeMounts) && live.nativeMounts.includes('/api/delivery'));
  assert.equal(live.realtimeSocket, null, 'no fake WS tunnel advertised');
  const dumped = JSON.stringify(live);
  assert.ok(!dumped.includes(BRIDGE_SECRET) && !dumped.includes('postgres://'), 'capability leaks key material');
  const alice = await h.pairAs('alice');
  const me = await h.api('GET', '/v1/me', { token: alice });
  assert.equal(me.json.agentMode, 'full-upstream');
  assert.equal(me.json.fullConfigured, true);
});

test('seeded cache proves setup at boot; staleness expires without refresh', async (t) => {
  const { writeFileSync } = await import('node:fs');
  const { writeDoctorCache, doctorCachePath } = await import('../src/upstream-doctor.mjs');
  // Seed BEFORE server construction: restart picks the on-disk evidence up.
  // Kick disabled + long interval: no refresh can overwrite the seed here.
  const h = await launch(t, { fake: 'unhealthy', liveIntervalMs: 60_000, liveKick: false });
  writeDoctorCache(doctorCachePath(h.dbPath), { state: 'READY', checks: { mode: 'full' } }, { fs: { writeFileSync } });
  await h.restart();
  const seeded = await h.api('GET', '/healthz');
  assert.equal(seeded.json.fullConfigured, true, 'restart seeds from last evidence');
  // Stale file: TTL-bound in-memory read expires back to setup-needed.
  writeDoctorCache(doctorCachePath(h.dbPath), { state: 'READY', checks: { mode: 'full' } }, { fs: { writeFileSync }, at: Date.now() - 3_600_000 });
  await h.restart();
  const stale = await h.api('GET', '/healthz');
  assert.equal(stale.json.fullConfigured, false);
  assert.equal(stale.json.liveEvidence.reason, 'stale');
});

test('native REST roundtrip through the real HTTP boundary', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const roster = await h.api('GET', '/api/agents', { token: alice });
  assert.equal(roster.status, 200);
  assert.equal(roster.json.agents[0].id, 'bot_help');
  const created = await h.api('POST', '/api/channels/', { token: alice, body: { agentIds: ['bot_help'] } });
  assert.equal(created.status, 201);
  const channelId = created.json.channel.id;
  const sent = await h.api('POST', `/api/delivery/conversations/${channelId}/messages`, {
    token: alice, body: { agentId: 'bot_help', text: 'Hello upstream', externalId: '11111111-1111-4111-8111-111111111111' },
  });
  assert.equal(sent.status, 202);
  const hist = await h.api('GET', `/api/delivery/conversations/${channelId}/history?agentId=bot_help`, { token: alice });
  assert.equal(hist.status, 200);
  assert.ok(hist.json.history.some((m) => m.content === 'Hello upstream'));
  const convs = await h.api('GET', '/api/delivery/conversations', { token: alice });
  assert.ok(convs.json.conversations.some((c) => c.id === channelId));
  // Every signed upstream call carries a valid assertion; the role comes
  // from the home admin allowlist (alice is admin), not from upstream.
  // (Anonymous health/capabilities probes carry no assertion by design;
  // the tracker's own read-only probe signs as me-live-probe/user.)
  const signed = h.fake.seen.filter((s) => s.assertionPresent && s.assertionUser !== 'me-live-probe');
  assert.ok(signed.length > 0);
  assert.ok(signed.every((s) => s.assertionRole === 'admin'));
});

test('two families stay isolated through the real HTTP boundary', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  const created = await h.api('POST', '/api/channels/', { token: alice, body: { agentIds: ['bot_help'] } });
  const channelId = created.json.channel.id;
  const bobList = await h.api('GET', '/api/channels/', { token: bob });
  assert.equal(bobList.status, 200);
  assert.ok(!bobList.json.channels.some((c) => c.id === channelId), 'bob sees alice channel');
  const bobGet = await h.api('GET', `/api/channels/${channelId}`, { token: bob });
  assert.equal(bobGet.status, 404);
  const bobMsg = await h.api('POST', `/api/delivery/conversations/${channelId}/messages`, {
    token: bob, body: { agentId: 'bot_help', text: 'intrude', externalId: '22222222-2222-4222-8222-222222222222' },
  });
  assert.ok([400, 404].includes(bobMsg.status), `expected refusal, got ${bobMsg.status}`);
  const bobHist = await h.api('GET', `/api/delivery/conversations/${channelId}/history?agentId=bot_help`, { token: bob });
  assert.ok([400, 404].includes(bobHist.status));
});

test('phone-supplied assertion is ignored; server-side assertion wins', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const forged = await h.api('GET', '/api/agents', {
    token: alice, headers: { 'x-me-home-assertion': 'v1.bob_up.9999999999999.user.deadbeef' },
  });
  assert.equal(forged.status, 200, 'server must overwrite the spoofed assertion, not fail on it');
  const noAuth = await h.api('GET', '/api/agents', {
    headers: { 'x-me-home-assertion': 'v1.bob_up.9999999999999.user.deadbeef' },
  });
  assert.equal(noAuth.status, 401);
});

test('FULL compat tasks execute upstream; legacy reads stay safe', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice, body: { title: 'Trip' } });
  assert.equal(conv.status, 201);
  const legacy = await h.api('GET', `/v1/conversations/${conv.json.id}/tasks`, { token: alice });
  assert.equal(legacy.status, 200);
  const missing = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice, body: { request: 'Do it' },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'agent_required');
  const created = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice, body: { request: 'Do it', agentId: 'bot_help' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.execution, 'full-upstream');
  const got = await h.api('GET', `/v1/tasks/${created.json.id}`, { token: alice });
  assert.equal(got.status, 200);
  assert.equal(got.json.execution, 'full-upstream');
});

test('core mode leaves native paths unmounted (legacy only)', async (t) => {
  const h = await launch(t, { env: { ...FULL_ENV, ME_UPSTREAM_MODE: 'core' } });
  const alice = await h.pairAs('alice');
  const roster = await h.api('GET', '/api/agents', { token: alice });
  assert.equal(roster.status, 404);
  const health = await h.api('GET', '/healthz');
  assert.equal(health.json.agentMode, 'legacy');
});

test('proxy allowlist is segment-exact; private callbacks and fake realtime never exposed', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  for (const path of ['/api/agentsXYZ', '/api/agent-tools/call', '/api/auth/session', '/api/channelsXYZ']) {
    const r = await h.api('GET', path, { token: alice });
    assert.equal(r.status, 404, `${path} must not match the allowlist`);
  }
  const wrongMethod = await h.api('DELETE', '/api/agents', { token: alice });
  assert.equal(wrongMethod.status, 405);
  const events = await h.api('GET', '/api/channels/events', { token: alice });
  assert.equal(events.status, 501);
  assert.equal(events.json.error.code, 'ws_tunnel_pending');
});

test('relay strips set-cookie/private redirects and enforces caps', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  // Capture raw response headers: set-cookie from upstream must not relay.
  const raw = await fetch(`${h.base}/api/agents`, { headers: { authorization: `Bearer ${alice}` } });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('set-cookie'), null, 'upstream set-cookie stripped');
  assert.ok(!raw.headers.get('content-type')?.includes('text/html'));
});

test('upstream redirect and oversize are refused, never relayed', async (t) => {
  const { mkdtemp: mk, rm: rmf } = await import('node:fs/promises');
  const { tmpdir: td } = await import('node:os');
  const dir = await mk(join(td(), 'me-proxy-unit-'));
  t.after(async () => { await rmf(dir, { recursive: true, force: true }); });
  const { openHomeDb, closeHomeDb } = await import('../src/db.mjs');
  const { ensureUser } = await import('../src/server.mjs');
  const { forwardNative } = await import('../src/upstream-proxy.mjs');
  const { db } = openHomeDb(join(dir, 'home.sqlite'));
  t.after(() => { try { closeHomeDb({ db }); } catch {} });
  ensureUser(db, 'alice', 'alice');
  const env = { ...FULL_ENV };
  const redirectFetch = async () => ({ status: 301, headers: { get: () => 'http://127.0.0.1:3001/private' }, arrayBuffer: async () => Buffer.from('') });
  await assert.rejects(
    forwardNative({ db, session: { user_id: 'alice' }, pathname: '/api/agents', method: 'GET', env, fetchImpl: redirectFetch }),
    (e) => e.code === 'upstream_redirect',
  );
  const bigFetch = async () => ({ status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.alloc(64) });
  await assert.rejects(
    forwardNative({ db, session: { user_id: 'alice' }, pathname: '/api/agents', method: 'GET', env, fetchImpl: bigFetch, maxBytes: 16 }),
    (e) => e.code === 'upstream_too_large',
  );
  await assert.rejects(
    forwardNative({ db, session: { user_id: 'alice' }, pathname: '/api/channels/events', method: 'GET', env, fetchImpl: bigFetch }),
    (e) => e.code === 'ws_tunnel_pending',
  );
});
