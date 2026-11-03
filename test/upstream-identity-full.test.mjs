import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHomeDb, closeHomeDb } from '../src/db.mjs';
import { ensureUser } from '../src/server.mjs';
import {
  ensureUpstreamUser,
  getUpstreamUser,
  identifyUpstreamUserForSession,
  identifyUpstreamActorForSession,
} from '../src/upstream-identity.mjs';
import {
  mintThreadId,
  ownsThread,
  getOrMintThreadForConversation,
  submitToUpstream,
  listLegacyConversations,
  resolveAgentTarget,
} from '../src/upstream-full.mjs';

async function launch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'me-upstream-full-'));
  const dbPath = join(dir, 'home.sqlite');
  const { db } = openHomeDb(dbPath);
  t.after(async () => { try { closeHomeDb({ db }); } catch {} await rm(dir, { recursive: true, force: true }); });
  ensureUser(db, 'alice', 'alice');
  ensureUser(db, 'bob', 'bob');
  const conv = (owner, title) => {
    const id = `conv_${owner}_${Math.random().toString(16).slice(2)}`;
    db.prepare('INSERT INTO conversations(id, owner_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(id, owner, title, Date.now(), Date.now());
    return id;
  };
  return { db, conv };
}

test('identity hook is server-side 1:1, role locally configured, never first-visitor admin', async (t) => {
  const { db } = await launch(t);
  const env = { ME_UPSTREAM_ADMIN_USERS: 'alice' };
  const a = ensureUpstreamUser(db, 'alice', { upstreamUserId: 'alice_up', email: 'alice@example.com', env });
  assert.equal(a.role, 'admin');
  const b = ensureUpstreamUser(db, 'bob', { upstreamUserId: 'bob_up', env });
  assert.equal(b.role, 'user');
  // Same Me user re-linked keeps 1:1 (upsert, unique upstream id).
  const a2 = ensureUpstreamUser(db, 'alice', { upstreamUserId: 'alice_up', env });
  assert.equal(a2.upstream_user_id, 'alice_up');
  assert.equal(getUpstreamUser(db, 'bob').upstream_user_id, 'bob_up');
  // IdentifyUser scopes threads to mapped id; actor carries local role.
  assert.deepEqual(identifyUpstreamUserForSession(db, { user_id: 'alice' }), { id: 'alice_up', name: 'alice' });
  assert.deepEqual(identifyUpstreamActorForSession(db, { user_id: 'bob' }), { id: 'bob_up', role: 'user' });
  assert.deepEqual(identifyUpstreamActorForSession(db, null), { id: '', role: 'user' });
  assert.throws(() => identifyUpstreamUserForSession(db, { user_id: 'mallory' }), /not linked/);
});

test('two users cannot cross conversations or threads', async (t) => {
  const { db, conv } = await launch(t);
  const env = { ME_UPSTREAM_ADMIN_USERS: 'alice' };
  ensureUpstreamUser(db, 'alice', { upstreamUserId: 'alice_up', env });
  ensureUpstreamUser(db, 'bob', { upstreamUserId: 'bob_up', env });
  const ca = conv('alice', 'A');
  const cb = conv('bob', 'B');
  const ta = getOrMintThreadForConversation(db, { homeConversationId: ca, meUserId: 'alice', deploymentId: 'me-home' });
  const tb = getOrMintThreadForConversation(db, { homeConversationId: cb, meUserId: 'bob', deploymentId: 'me-home' });
  assert.notEqual(ta, tb);
  assert.ok(ownsThread(ta, 'me-home'));
  assert.ok(!ownsThread(ta, 'other-deploy'));
  // Bob cannot resolve Alice's conversation (owner check).
  assert.throws(() => getOrMintThreadForConversation(db, { homeConversationId: ca, meUserId: 'bob', deploymentId: 'me-home' }), /not found/i);
  // Stable mapping (no duplicate thread on re-read).
  assert.equal(getOrMintThreadForConversation(db, { homeConversationId: ca, meUserId: 'alice', deploymentId: 'me-home' }), ta);
  // Legacy adapter marks old rows explicitly, never migrates.
  const legacy = listLegacyConversations(db, 'alice');
  assert.ok(legacy.some((r) => r.id === ca && r.legacy === true));
});

test('minted thread ids carry deployment fingerprint (UUIDv8)', () => {
  const id = mintThreadId('me-home');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(ownsThread(id, 'me-home'));
});

test('FULL submit executes real native upstream calls (channel + message), never local execution', async (t) => {
  const { db, conv } = await launch(t);
  ensureUpstreamUser(db, 'alice', { upstreamUserId: 'alice_up', env: {} });
  const ca = conv('alice', 'Help');
  const fullEnv = {
    ME_UPSTREAM_MODE: 'full',
    UPSTREAM_SERVER_URL: 'http://127.0.0.1:3001',
    DATABASE_URL: 'postgres://openbot:x@postgres:5432/openbot',
    KEY_ENCRYPTION_KEY: 'k'.repeat(44),
    ME_HOME_BRIDGE_SECRET: 'bridge-secret-0123456789abcdef',
    INTELLIGENCE_API_URL: 'https://intel.home.example',
    INTELLIGENCE_GATEWAY_WS_URL: 'wss://intel.home.example',
    CPK_INTELLIGENCE_API_KEY: 'k',
    BETTER_AUTH_URL: 'http://127.0.0.1:3001',
    BETTER_AUTH_SECRET: 's'.repeat(32),
    INITIAL_ADMIN_EMAILS: 'alice@example.com',
    COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
    SUPERVISOR_TOKEN: 's',
    COMPUTER_TOKEN: 'c',
    MANAGED_AGENT_AG_UI_URL: 'http://127.0.0.1:4201/ag-ui',
    MANAGED_AGENT_TOKEN: 'tok',
    DEPLOYMENT_ID: 'me-home',
  };
  const calls = [];
  const fakeJson = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const headers = init?.headers ?? {};
    // Phone bearer must never be forwarded upstream; only the signed assertion travels.
    assert.ok(!headers.authorization, 'phone bearer forwarded upstream');
    assert.ok(!headers.cookie, 'cookie forwarded upstream');
    assert.match(headers['x-me-home-assertion'] ?? '', /^v2\.alice_up\.\d+\.(admin|user)\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    if (url === 'http://127.0.0.1:3001/api/channels/' && init?.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { agentIds: ['bot_help'] });
      return fakeJson(201, { channel: { id: 'ch_1', name: 'Help', agentIds: ['bot_help'], active: true } });
    }
    if (url === 'http://127.0.0.1:3001/api/delivery/conversations/ch_1/messages' && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.agentId, 'bot_help');
      assert.equal(body.text, 'Help me');
      assert.match(body.externalId, /^[0-9a-f-]{36}$/);
      return fakeJson(202, { accepted: true });
    }
    throw new Error(`unexpected upstream call ${init?.method} ${url}`);
  };
  const out = await submitToUpstream(db, {
    session: { user_id: 'alice' }, homeConversationId: ca,
    title: 'Help', request: 'Help me', agentId: 'bot_help', env: fullEnv, fetchImpl,
  });
  assert.equal(out.delegated, true);
  assert.equal(out.protocol, 'native-upstream');
  assert.equal(out.upstreamUserId, 'alice_up');
  assert.equal(out.channelId, 'ch_1');
  assert.match(out.externalId, /^[0-9a-f-]{36}$/);
  assert.equal(out.task.execution, 'full-upstream');
  assert.equal(calls.length, 2);
  // Missing upstream => NEEDS_SETUP, never silent legacy execution.
  await assert.rejects(() => submitToUpstream(db, { session: { user_id: 'alice' }, homeConversationId: ca, agentId: 'b', env: { ME_UPSTREAM_MODE: 'full' } }), (e) => e.code === 'upstream_not_configured');
  // Wrong mode => not delegated.
  await assert.rejects(() => submitToUpstream(db, { session: { user_id: 'alice' }, homeConversationId: ca, agentId: 'b', env: { ME_UPSTREAM_MODE: 'core' } }), /FULL primary required/);
  // Unlinked owner => needs setup.
  await assert.rejects(() => submitToUpstream(db, { session: { user_id: 'bob' }, homeConversationId: conv('bob', 'x'), agentId: 'b', env: fullEnv, fetchImpl }), /not linked/);
  // No roster guessing: agentId is explicit.
  await assert.rejects(() => submitToUpstream(db, { session: { user_id: 'alice' }, homeConversationId: ca, env: fullEnv, fetchImpl }), (e) => e.code === 'agent_required');
});

test('agent target resolves harness packaging for B', () => {
  const t = resolveAgentTarget({ MANAGED_AGENT_AG_UI_URL: 'http://127.0.0.1:4201/ag-ui', MANAGED_AGENT_TOKEN: 'tok', BOT_ID: 'helper' });
  assert.equal(t.harness, 'agent-langgraph-agui');
  assert.equal(t.pin, '6bfee780c8e8d05141375ea55ebde33eefb3dbc0');
  assert.match(t.transport, /HttpAgent/);
  // No stale 4201/ag-ui fallback: the canonical native default is POST / root on 4206.
  const d = resolveAgentTarget({});
  assert.equal(d.endpoint, 'http://127.0.0.1:4206/');
});
