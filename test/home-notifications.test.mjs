// H7: opt-in private task notifications — outbox + device-me registration.
// Fake provider only; no real Expo/APNs credentials, no outbound network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_BRIDGE = join(ROOT, 'test', 'fixture-bridge.mjs');
const DELEG_BRIDGE = join(ROOT, 'test', 'fixture-delegation-bridge.mjs');

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

function makeFake(overrides = {}) {
  const fake = {
    name: 'fake',
    sent: [],
    tickets: overrides.tickets ?? null, // array or fn to control per-call tickets
    receipts: overrides.receipts ?? {},
    failNext: 0,
    failWith: null,
    calls: 0,
    async sendBatch(messages) {
      fake.calls += 1;
      for (const m of messages) fake.sent.push(JSON.parse(JSON.stringify(m)));
      if (fake.failWith && fake.failNext > 0) {
        fake.failNext -= 1;
        throw new Error(fake.failWith);
      }
      if (typeof fake.tickets === 'function') return fake.tickets(messages);
      if (Array.isArray(fake.tickets)) return fake.tickets;
      return messages.map((_, i) => ({ ticketStatus: 'ok', ticketId: `ticket-${fake.calls}-${i}` }));
    },
    async getReceipts(ids) {
      const out = {};
      for (const id of ids) out[id] = fake.receipts[id] ?? { status: 'ok' };
      return out;
    },
  };
  return fake;
}

function notifConfig(overrides = {}) {
  return {
    enabled: true,
    projectId: null,
    accessToken: null,
    maxAttempts: 8,
    baseDelayMs: 50,
    maxDelayMs: 200,
    batchSize: 10,
    sendTimeoutMs: 2000,
    expiryMs: 60 * 60 * 1000,
    pumpIntervalMs: 60000,
    ...overrides,
  };
}

function fixtureBroker(bridge = FIXTURE_BRIDGE, overrides = {}) {
  return {
    runtime: { command: [process.execPath, bridge], cwd: undefined },
    model: { provider: 'fixture', model: 'fixture-echo' },
    pollMs: 25,
    termination: { termGraceMs: 500, killGraceMs: 500, wallAllowanceMs: 500, shutdownMs: 10000 },
    ...overrides,
  };
}

async function launch(t, { bridge = FIXTURE_BRIDGE, brokerOverrides = {}, fake = makeFake(), config = notifConfig(), withNotif = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h7-'));
  const dbPath = join(dir, 'home.sqlite');
  const tasksRoot = join(dir, 'tasks');
  const broker = { ...fixtureBroker(bridge), ...brokerOverrides, tasksRoot };
  const start = async () => {
    const opts = { dbPath, broker, env: {} };
    if (withNotif) opts.notifications = { provider: fake, config };
    const server = createHomeServer(opts);
    const info = await server.start({ host: '127.0.0.1', port: 0 });
    return { server, base: `http://${info.host}:${info.port}` };
  };
  let current = await start();
  t.after(async () => {
    try { await current.server.stop(); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });
  for (const u of ['alice', 'bob']) ensureUser(current.server.db, u, `${u} (dev fixture)`);
  const api = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${current.base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const pairAs = async (user) => {
    const inv = createInvitation(current.server.db, user, 60_000);
    const paired = await api('POST', '/v1/pair', { body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret } });
    assert.equal(paired.status, 201);
    const sess = await api('POST', '/v1/sessions', { body: { device_id: paired.json.device_id, device_secret: paired.json.device_secret } });
    assert.equal(sess.status, 201);
    return { ...paired.json, token: sess.json.token };
  };
  const restart = async () => {
    await current.server.stop();
    current = await start();
  };
  const waitTask = async (token, taskId, wants, timeoutMs = 30000) => {
    const want = Array.isArray(wants) ? wants : [wants];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await api('GET', `/v1/tasks/${taskId}`, { token });
      assert.equal(res.status, 200);
      if (want.includes(res.json.status)) return res.json;
      if (['succeeded', 'failed', 'cancelled'].includes(res.json.status)) {
        throw new Error(`task settled as ${res.json.status} while waiting for ${want}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${want}; last=${res.json.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { api, pairAs, restart, waitTask, fake, get server() { return current.server; }, get base() { return current.base; } };
}

test('H7: register/status/disable round trip with strict validation, no raw token', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  // Strict token format.
  for (const bad of ['nope', 'ExponentPushToken[]', 'ExponentPushToken[' + 'x'.repeat(300) + ']', 'https://evil.example/hook', 42, null]) {
    const r = await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: bad, permission_enabled: true } });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error.code, 'invalid_push_token');
  }
  // permission_enabled must be a real boolean.
  assert.equal((await h.api('POST', '/v1/notifications/register', {
    token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: 'true' },
  })).status, 400);
  // Home-managed IDs are never accepted.
  for (const extra of [{ user_id: 'alice' }, { device_id: 'dev_x' }, { installation_id: 'x' }]) {
    const r = await h.api('POST', '/v1/notifications/register', {
      token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true, ...extra },
    });
    assert.equal(r.status, 400);
  }
  assert.equal((await h.api('POST', '/v1/notifications/register', { body: { expo_push_token: TOKEN_A, permission_enabled: true } })).status, 401);
  const ok = await h.api('POST', '/v1/notifications/register', {
    token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.registered, true);
  assert.equal(ok.json.enabled, true);
  assert.ok(!('expo_push_token' in ok.json), 'raw token must never be returned');
  const status = await h.api('GET', '/v1/notifications/status', { token: alice.token });
  assert.equal(status.status, 200);
  assert.equal(status.json.registered, true);
  assert.equal(status.json.enabled, true);
  assert.equal(status.json.permission_enabled, true);
  assert.ok(status.json.token_suffix, 'masked suffix for debugging');
  assert.ok(!('expo_push_token' in status.json) && !('push_token' in status.json));
  assert.ok(!JSON.stringify(status.json).includes(TOKEN_A), 'raw token must not leak via status');
  const off = await h.api('POST', '/v1/notifications/disable', { token: alice.token });
  assert.equal(off.status, 200);
  assert.equal((await h.api('GET', '/v1/notifications/status', { token: alice.token })).json.enabled, false);
});

test('H7: disabled by default makes no network calls', async (t) => {
  const fake = makeFake();
  const h = await launch(t, { withNotif: false });
  // Replace provider with a call-counting fake on the disabled service.
  h.server.notifications.provider = fake;
  assert.equal(h.server.notifications.enabled, false);
  const alice = await h.pairAs('alice');
  const reg = await h.api('POST', '/v1/notifications/register', {
    token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true },
  });
  assert.equal(reg.status, 403);
  assert.equal(reg.json.error.code, 'notifications_disabled');
  const pumped = await h.server.notifications.pump();
  assert.equal(pumped.skipped, true);
  assert.equal(fake.calls, 0, 'disabled mode must never touch the network');
});

test('H7: waiting_input triggers one metadata-only push via the settled hook', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: { title: 'Secret trip plans' } });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'plan the surprise party for BOB at midnight\nASK:Which venue?' },
  });
  assert.equal(sub.status, 201);
  // Task detail carries conversation_id for tap resolution (opaque IDs).
  assert.equal(sub.json.conversation_id, conv.json.id);
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  assert.ok(waiting.questions?.length);
  // Settled hook auto-pumps; force one more bounded pump for determinism.
  await h.server.notifications.pump();
  await h.server.notifications.pump();
  assert.equal(h.fake.sent.length, 1);
  const push = h.fake.sent[0];
  assert.equal(push.to, TOKEN_A);
  assert.ok(push.title && push.body, 'generic title/body present');
  assert.ok(!JSON.stringify(push).includes('surprise') && !JSON.stringify(push).includes('BOB'),
    'private request text must never enter the payload');
  assert.ok(!JSON.stringify(push).includes('Secret trip'), 'conversation title must never enter the payload');
  assert.ok(!('url' in push) && !JSON.stringify(push).includes('http'), 'no URLs in push');
  assert.deepEqual(Object.keys(push.data).sort(), ['device_id', 'event_id', 'installation_id', 'kind', 'task_id']);
  assert.equal(push.data.kind, 'waiting_input');
  assert.equal(push.data.task_id, sub.json.id);
  assert.equal(push.data.installation_id, h.server.installationId);
  assert.ok(push.data.event_id.includes(sub.json.id), 'stable event id for phone dedupe');
  assert.match(push.title, /Action needed/);
});

test('H7: root completion notifies; child completion never spams', async (t) => {
  const h = await launch(t, { bridge: DELEG_BRIDGE });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'parent job\nSPAWN:research-1:hello from child', title: 'Parent' },
  });
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.ok(done);
  await h.server.notifications.pump();
  const rows = h.server.db.prepare('SELECT task_id, kind FROM notification_outbox').all();
  assert.ok(rows.length >= 1, 'root completion enqueues at least one row');
  assert.ok(rows.every((r) => r.task_id === sub.json.id), 'only the root task may enqueue (no child storm)');
  assert.ok(h.fake.sent.length >= 1);
  assert.ok(h.fake.sent.every((m) => m.data.task_id === sub.json.id));
  assert.ok(h.fake.sent.some((m) => m.data.kind === 'completed'));
});

test('H7: receipt DeviceNotRegistered disables the binding', async (t) => {
  const fake = makeFake({ tickets: () => [{ ticketStatus: 'error', message: 'DeviceNotRegistered', details: { error: 'DeviceNotRegistered' } }] });
  const h = await launch(t, { fake });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'quick\nASK:Pick one?' },
  });
  await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  await h.server.notifications.pump();
  const status = await h.api('GET', '/v1/notifications/status', { token: alice.token });
  assert.equal(status.json.enabled, false, 'DeviceNotRegistered must retire the binding');
  const row = h.server.db.prepare("SELECT status FROM notification_outbox WHERE task_id = ?").get(sub.json.id);
  assert.equal(row.status, 'dropped');
});

test('H7: restart dedupes by stable event id (at-least-once, phone dedupes)', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'hold\nASK:Which one?' },
  });
  await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  const task = await h.server.broker.store.get('alice', 'tasks', sub.json.id);
  const first = h.server.notifications.enqueueForTask('alice', task);
  const second = h.server.notifications.enqueueForTask('alice', task);
  assert.equal(second, 0, 'same event+device must dedupe');
  const count = h.server.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n;
  assert.equal(count, 1, 'exactly one outbox row per event+device across statuses');
  await h.restart();
  const after = h.server.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n;
  assert.ok(after <= 1, 'restart must not duplicate rows');
  const pumped = await h.server.notifications.pump();
  assert.ok(pumped.sent <= 1);
});

test('H7: revoked device before send drops without network', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  // Craft a waiting root directly (no worker run) for deterministic timing.
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const now = new Date().toISOString();
  const task = {
    id: 'task_stale_revoke', title: 'stale', prompt: 'q', kind: 'agent', status: 'waiting_input',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_stale_revoke',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: conv.json.id, runId: 'task_stale_revoke', request: 'q', capabilities: { files: true, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h.server.broker.model },
    state: {}, createdAt: now, updatedAt: now, attempts: 1, leaseId: null, leaseUntil: null, artifactIds: [],
    question: 'Pick?', questions: [{ id: 'q1', prompt: 'Pick?' }],
  };
  await h.server.broker.store.put('alice', 'tasks', task);
  assert.equal(h.server.notifications.enqueueForTask('alice', task), 1);
  // Revoke the device before the pump runs.
  const callsBefore = h.fake.calls;
  assert.equal((await h.api('POST', `/v1/devices/${alice.device_id}/revoke`, { token: alice.token })).status, 200);
  const out = await h.server.notifications.pump();
  assert.equal(h.fake.calls, callsBefore, 'revoked device must never be sent to');
  assert.equal(out.dropped, 1);
  const row = h.server.db.prepare('SELECT status FROM notification_outbox WHERE task_id = ?').get(task.id);
  assert.equal(row.status, 'dropped');
});

test('H7: answered wait-state goes stale and drops', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  // Craft a waiting root directly so the answer lands before any pump runs.
  const now = new Date().toISOString();
  const task = {
    id: 'task_stale_answer', title: 'stale', prompt: 'q', kind: 'agent', status: 'waiting_input',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_stale_answer',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: conv.json.id, runId: 'task_stale_answer', request: 'q', capabilities: { files: true, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h.server.broker.model },
    state: {}, createdAt: now, updatedAt: now, attempts: 1, leaseId: null, leaseUntil: null, artifactIds: [],
    question: 'Pick?', questions: [{ id: 'q1', prompt: 'Pick?' }],
  };
  await h.server.broker.store.put('alice', 'tasks', task);
  assert.equal(h.server.notifications.enqueueForTask('alice', task), 1);
  // User answers on the live API path (status leaves waiting_input) before send.
  await h.server.broker.store.compareAndSwap('alice', 'tasks', task.id, { status: 'waiting_input' }, { status: 'queued', updatedAt: new Date().toISOString() });
  const callsBefore = h.fake.calls;
  const out = await h.server.notifications.pump();
  assert.equal(h.fake.calls, callsBefore, 'answered wait-state must drop without sending');
  assert.equal(out.dropped, 1);
  assert.equal(h.server.db.prepare('SELECT status FROM notification_outbox WHERE task_id = ?').get(task.id).status, 'dropped');
  // A fresh completion event for the same task is a new event id and may notify.
  const done = { ...(await h.server.broker.store.get('alice', 'tasks', task.id)), status: 'succeeded', updatedAt: new Date().toISOString() };
  await h.server.broker.store.compareAndSwap('alice', 'tasks', task.id, { status: 'queued' }, { status: 'succeeded', updatedAt: done.updatedAt });
  assert.equal(h.server.notifications.enqueueForTask('alice', done), 1);
  await h.server.notifications.pump();
  assert.equal(h.fake.sent.length, 1);
  assert.equal(h.fake.sent[0].data.kind, 'completed');
});

test('H7: same push address re-registered by a new device retires the old binding', async (t) => {
  const h = await launch(t);
  const first = await h.pairAs('alice');
  assert.equal((await h.api('POST', '/v1/notifications/register', {
    token: first.token, body: { expo_push_token: TOKEN_A, permission_enabled: true },
  })).status, 200);
  const second = await h.pairAs('alice');
  assert.equal((await h.api('POST', '/v1/notifications/register', {
    token: second.token, body: { expo_push_token: TOKEN_A, permission_enabled: true },
  })).status, 200);
  assert.equal((await h.api('GET', '/v1/notifications/status', { token: first.token })).json.enabled, false);
  assert.equal((await h.api('GET', '/v1/notifications/status', { token: second.token })).json.enabled, true);
  // Next task notifies only the current device.
  const conv = await h.api('POST', '/v1/conversations', { token: second.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: second.token, body: { request: 'hello\nASK:Hi?' },
  });
  await h.waitTask(second.token, sub.json.id, 'waiting_input');
  await h.server.notifications.pump();
  const rows = h.server.db.prepare('SELECT device_id FROM notification_outbox WHERE task_id = ?').all(sub.json.id);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.device_id === second.device_id), 'old binding must not receive');
});

test('H7: cross-owner isolation — wrong device gets nothing and disables nothing', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  // Bob has no binding.
  assert.equal((await h.api('GET', '/v1/notifications/status', { token: bob.token })).json.registered, false);
  // Bob's disable touches only his own (absent) device.
  assert.equal((await h.api('POST', '/v1/notifications/disable', { token: bob.token })).status, 200);
  assert.equal((await h.api('GET', '/v1/notifications/status', { token: alice.token })).json.enabled, true);
  // Bob's task cannot notify Alice's device.
  const bconv = await h.api('POST', '/v1/conversations', { token: bob.token, body: {} });
  const bsub = await h.api('POST', `/v1/conversations/${bconv.json.id}/tasks`, {
    token: bob.token, body: { request: 'bob private\nASK:Bob pick?' },
  });
  await h.waitTask(bob.token, bsub.json.id, 'waiting_input');
  await h.server.notifications.pump();
  assert.equal(h.fake.sent.length, 0, 'unregistered owner must not trigger sends');
  assert.equal((await h.api('GET', `/v1/tasks/${bsub.json.id}`, { token: alice.token })).status, 404);
});

test('H7: permission denied stores a disabled binding and sends nothing', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  assert.equal((await h.api('POST', '/v1/notifications/register', {
    token: alice.token, body: { expo_push_token: TOKEN_B, permission_enabled: false },
  })).status, 200);
  assert.equal((await h.api('GET', '/v1/notifications/status', { token: alice.token })).json.enabled, false);
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'quiet\nASK:Pick?' },
  });
  await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  await h.server.notifications.pump();
  assert.equal(h.fake.sent.length, 0);
});

test('H7: transient failures retry bounded, then drop (no unbounded loops)', async (t) => {
  const fake = makeFake();
  fake.failWith = 'connection reset';
  fake.failNext = 100;
  const h = await launch(t, { fake, config: notifConfig({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 }) });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'flaky\nASK:Pick?' },
  });
  await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  fake.failNext = 100; // keep failing through the retries
  for (let i = 0; i < 5; i++) {
    h.server.db.prepare("UPDATE notification_outbox SET next_attempt_at = 0 WHERE status = 'queued'").run();
    await h.server.notifications.pump();
  }
  const row = h.server.db.prepare('SELECT status, attempts FROM notification_outbox WHERE task_id = ?').get(sub.json.id);
  assert.equal(row.status, 'dropped');
  assert.ok(row.attempts <= 3, `attempts bounded (got ${row.attempts})`);
  assert.ok(fake.calls <= 4, `pump calls bounded (got ${fake.calls})`);
  const callsAfterDrop = fake.calls;
  h.server.db.prepare("UPDATE notification_outbox SET next_attempt_at = 0 WHERE status = 'queued'").run();
  await h.server.notifications.pump();
  assert.equal(fake.calls, callsAfterDrop, 'dropped rows are never retried');
});
