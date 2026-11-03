// H7.1 review gaps: child human-wait alerts, hardened transport, durable
// lease claims, delayed receipts, retention, trusted runtime env.
// Fake providers only; no real Expo calls, no outbound network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';
import { openHomeDb, closeHomeDb } from '../src/db.mjs';
import {
  createExpoHttpProvider,
  createNotificationService,
  EXPO_PUSH_URL,
} from '../src/notifications.mjs';
import { buildRuntimeEnv } from '../src/task-broker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELEG_BRIDGE = join(ROOT, 'test', 'fixture-delegation-bridge.mjs');

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

function makeFake(overrides = {}) {
  const fake = {
    name: 'fake',
    sent: [],
    calls: 0,
    delayMs: overrides.delayMs ?? 0,
    sendImpl: overrides.sendImpl ?? null,
    receipts: overrides.receipts ?? {},
    receiptCalls: [],
    async sendBatch(messages, opts = {}) {
      fake.calls += 1;
      if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
      if (fake.sendImpl) return fake.sendImpl(messages, opts, fake.calls);
      for (const m of messages) fake.sent.push(JSON.parse(JSON.stringify(m)));
      return messages.map((_, i) => ({ ticketStatus: 'ok', ticketId: `ticket-${fake.calls}-${i}` }));
    },
    async getReceipts(ids, opts = {}) {
      fake.receiptCalls.push([...ids]);
      void opts;
      const out = {};
      for (const id of ids) {
        if (Object.hasOwn(fake.receipts, id)) {
          const v = typeof fake.receipts[id] === 'function' ? fake.receipts[id]() : fake.receipts[id];
          if (v !== undefined) out[id] = v;
        } else {
          out[id] = { status: 'ok' };
        }
      }
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
    leaseMs: 60000,
    receiptDelayMs: 50,
    receiptMaxAttempts: 5,
    receiptBatch: 50,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    outboxMaxRows: 2000,
    ...overrides,
  };
}

async function launch(t, { fake = makeFake(), config = notifConfig() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h71-'));
  const dbPath = join(dir, 'home.sqlite');
  const tasksRoot = join(dir, 'tasks');
  const start = async () => {
    const server = createHomeServer({
      dbPath,
      broker: {
        runtime: { command: [process.execPath, DELEG_BRIDGE], cwd: undefined },
        model: { provider: 'fixture', model: 'fixture-echo' },
        pollMs: 25,
        termination: { termGraceMs: 500, killGraceMs: 500, wallAllowanceMs: 500, shutdownMs: 10000 },
        tasksRoot,
      },
      env: {},
      notifications: { provider: fake, config },
    });
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
    const res = await fetch(`${current.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json };
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
  return { api, pairAs, restart, waitTask, fake, get server() { return current.server; } };
}

function mkTask(id, status, convId, model, parentId = null) {
  const now = new Date().toISOString();
  return {
    id, title: 't', prompt: 'q', kind: 'agent', status,
    plan: [], evidence: [], parentTaskId: parentId, rootTaskId: parentId ? `root_${id}` : id,
    delegationKey: parentId ? `k-${id}` : null, delegationHash: null, depth: parentId ? 1 : 0, childIds: [],
    input: { conversationId: convId, runId: id, request: 'q', capabilities: { files: true, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model },
    state: {}, createdAt: now, updatedAt: now, attempts: 1, leaseId: null, leaseUntil: null, artifactIds: [],
    ...(status === 'waiting_input' ? { question: 'Pick?', questions: [{ id: 'q1', prompt: 'Pick?' }] } : {}),
  };
}

test('H7.1: delegated child waiting_input alerts with child id; child success stays silent, parent completion notifies', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'parent job\nSPAWN:asker:ASK:Which size?', title: 'Parent' },
  });
  assert.equal(sub.status, 201);
  const parked = await h.waitTask(alice.token, sub.json.id, 'waiting_children');
  assert.equal(parked.children.length, 1);
  const childId = parked.children[0];
  const childWaiting = await h.waitTask(alice.token, childId, 'waiting_input');
  assert.equal(childWaiting.questions[0].id, 'q1');
  await h.server.notifications.pump();
  const childRows = h.server.db.prepare('SELECT task_id, kind, status FROM notification_outbox WHERE task_id = ?').all(childId);
  assert.ok(childRows.length >= 1, 'child human-wait must enqueue');
  assert.ok(childRows.every((r) => r.kind === 'waiting_input'));
  assert.ok(h.fake.sent.some((m) => m.data.task_id === childId && m.data.kind === 'waiting_input'),
    'phone must get the child ask alert or the workflow stalls while closed');
  // Private request text must not leak even for child alerts.
  assert.ok(!JSON.stringify(h.fake.sent).includes('Which size?'));
  // Answer the child: it completes silently, the parent resumes and completes.
  const answered = await h.api('POST', `/v1/tasks/${childId}/inputs`, {
    token: alice.token, body: { inputs: [{ id: 'q1', answer: 'MP4' }] },
  });
  assert.equal(answered.status, 200);
  await h.waitTask(alice.token, childId, 'succeeded');
  await h.waitTask(alice.token, sub.json.id, 'succeeded');
  await h.server.notifications.pump();
  assert.equal(h.server.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE task_id = ? AND kind = 'completed'").get(childId).n, 0,
    'child success must stay silent (no completion storm)');
  assert.ok(h.server.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE task_id = ? AND kind = 'completed'").get(sub.json.id).n >= 1,
    'root completion still notifies');
});

test('H7.1: delegated child waiting_approval alerts; approval resumes silently', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'parent job\nSPAWN:gater:APPROVE:send email' },
  });
  const parked = await h.waitTask(alice.token, sub.json.id, 'waiting_children');
  const childId = parked.children[0];
  const waiting = await h.waitTask(alice.token, childId, 'waiting_approval');
  const publicId = waiting.pending_approvals[0].id;
  assert.ok(publicId.startsWith(`${childId}:`));
  await h.server.notifications.pump();
  assert.ok(h.fake.sent.some((m) => m.data.task_id === childId && m.data.kind === 'waiting_approval'),
    'child approval gate must alert');
  const decided = await h.api('POST', `/v1/tasks/${childId}/approvals`, {
    token: alice.token, body: { approvals: [{ id: publicId, decision: 'approve' }] },
  });
  assert.equal(decided.status, 200);
  await h.waitTask(alice.token, childId, 'succeeded');
  await h.server.notifications.pump();
  assert.equal(h.server.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE task_id = ? AND kind != 'waiting_approval'").get(childId).n, 0,
    'approved child must not emit completion noise');
});

test('H7.1: answered child wait drops stale without sending', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const child = mkTask('task_child_stale', 'waiting_input', conv.json.id, h.server.broker.model, 'task_parent_x');
  await h.server.broker.store.put('alice', 'tasks', child);
  assert.equal(h.server.notifications.enqueueForTask('alice', child), 1);
  await h.server.broker.store.compareAndSwap('alice', 'tasks', child.id, { status: 'waiting_input' }, { status: 'queued', updatedAt: new Date().toISOString() });
  const callsBefore = h.fake.calls;
  const out = await h.server.notifications.pump();
  assert.equal(h.fake.calls, callsBefore, 'answered child wait must drop without sending');
  assert.equal(out.dropped, 1);
});

test('H7.1: Expo transport refuses redirects and never forwards credentials', async (t) => {
  let calls = 0;
  let seenInit = null;
  const fetchImpl = async (url, init) => {
    calls += 1;
    seenInit = init;
    return { status: 307, ok: false, redirected: false, url, headers: { get: () => 'https://elsewhere.example/push' }, text: async () => '{"data":[]}' };
  };
  const provider = createExpoHttpProvider({ accessToken: 'secret-token', fetchImpl, timeoutMs: 2000 });
  await assert.rejects(() => provider.sendBatch([{ to: TOKEN_A, title: 't', body: 'b', data: {} }]), /redirect/i);
  assert.equal(calls, 1, 'exactly one request; the redirect target is never fetched');
  assert.equal(seenInit.redirect, 'error');
  assert.equal(seenInit.headers.authorization, 'Bearer secret-token');
});

test('H7.1: Expo transport rejects final-origin mismatch', async (t) => {
  const fetchImpl = async () => ({
    status: 200, ok: true, redirected: false, url: 'https://evil.example/push',
    text: async () => JSON.stringify({ data: [{ status: 'ok', id: 'r1' }] }),
  });
  const provider = createExpoHttpProvider({ fetchImpl, timeoutMs: 2000 });
  await assert.rejects(() => provider.sendBatch([{ to: TOKEN_A, title: 't', body: 'b', data: {} }]), /origin/i);
});

test('H7.1: Expo transport aborts stalled bodies within the deadline', async (t) => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(url, EXPO_PUSH_URL);
    return {
      status: 200, ok: true, redirected: false, url,
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel() {}, releaseLock() {} }) },
    };
  };
  const provider = createExpoHttpProvider({ fetchImpl, timeoutMs: 200 });
  const started = Date.now();
  await assert.rejects(() => provider.sendBatch([{ to: TOKEN_A, title: 't', body: 'b', data: {} }]), /timed out|aborted/i);
  assert.ok(Date.now() - started < 2000, 'stalled body must abort bounded, not hang');
});

test('H7.1: Expo transport rejects oversized responses', async (t) => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 200, ok: true, redirected: false, url: EXPO_PUSH_URL, text: async () => 'x'.repeat(300 * 1024) };
  };
  const provider = createExpoHttpProvider({ fetchImpl, timeoutMs: 2000 });
  await assert.rejects(() => provider.sendBatch([{ to: TOKEN_A, title: 't', body: 'b', data: {} }]), /exceeds/i);
  assert.equal(calls, 1);
});

test('H7.1: Expo receipts validate ids and shape', async (t) => {
  const okFetch = async () => ({
    status: 200, ok: true, redirected: false, url: EXPO_PUSH_URL, text: async () => JSON.stringify({ data: {} }),
  });
  const provider = createExpoHttpProvider({ fetchImpl: okFetch, timeoutMs: 2000 });
  await assert.rejects(() => provider.getReceipts(new Array(101).fill('r')), /at most/);
  const badShape = async () => ({
    status: 200, ok: true, redirected: false, url: EXPO_PUSH_URL, text: async () => JSON.stringify({ data: [1, 2] }),
  });
  await assert.rejects(() => createExpoHttpProvider({ fetchImpl: badShape, timeoutMs: 2000 }).getReceipts(['a']), /shape/);
});

test('H7.1: concurrent pumps on one DB claim the row exactly once', async (t) => {
  const fake = makeFake({ delayMs: 30 });
  const h = await launch(t, { fake });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const task = mkTask('task_race_claim', 'waiting_input', conv.json.id, h.server.broker.model);
  await h.server.broker.store.put('alice', 'tasks', task);
  assert.equal(h.server.notifications.enqueueForTask('alice', task), 1);
  const svcB = createNotificationService({
    db: h.server.db, installationId: h.server.installationId,
    config: h.server.notifications.config, provider: fake, store: h.server.broker.store,
  });
  const [a, b] = await Promise.all([h.server.notifications.pump(), svcB.pump()]);
  assert.equal(fake.sent.length, 1, 'two concurrent pumps must send once');
  assert.equal(a.sent + b.sent, 1);
  await svcB.stop();
});

test('H7.1: stale provider response cannot mark a row claimed under a newer lease', async (t) => {
  let releaseFirst = null;
  let calls = 0;
  const fake = makeFake({
    sendImpl: async (messages, opts, n) => {
      calls = n;
      if (n === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        for (const m of messages) fake.sent.push(JSON.parse(JSON.stringify(m)));
        return [{ ticketStatus: 'ok', ticketId: 'ticket-hung' }];
      }
      for (const m of messages) fake.sent.push(JSON.parse(JSON.stringify(m)));
      return [{ ticketStatus: 'ok', ticketId: 'ticket-fresh' }];
    },
  });
  const h = await launch(t, { fake });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const task = mkTask('task_fence', 'waiting_input', conv.json.id, h.server.broker.model);
  await h.server.broker.store.put('alice', 'tasks', task);
  assert.equal(h.server.notifications.enqueueForTask('alice', task), 1);
  const svcB = createNotificationService({
    db: h.server.db, installationId: h.server.installationId,
    config: h.server.notifications.config, provider: fake, store: h.server.broker.store,
  });
  const p1 = h.server.notifications.pump();
  const deadline = Date.now() + 5000;
  while (fake.calls < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fake.calls, 1);
  // Simulate lease expiry + recovery while the first send is still hung.
  const row = h.server.db.prepare('SELECT id, lease_id FROM notification_outbox WHERE task_id = ?').get(task.id);
  assert.equal(row.lease_id?.startsWith('lease_'), true);
  h.server.db.prepare("UPDATE notification_outbox SET status = 'queued', lease_id = NULL, lease_until = 0, updated_at = ? WHERE id = ?").run(Date.now(), row.id);
  const p2out = await svcB.pump();
  assert.equal(p2out.sent, 1);
  releaseFirst();
  const p1out = await p1;
  assert.equal(p1out.sent, 0, 'stale hung response must not count or overwrite');
  const final = h.server.db.prepare('SELECT status, receipt_id FROM notification_outbox WHERE id = ?').get(row.id);
  assert.equal(final.status, 'sent');
  assert.equal(final.receipt_id, 'ticket-fresh');
  await svcB.stop();
});

test('H7.1: stop aborts in-flight sends and resolves bounded', async (t) => {
  const fake = makeFake({
    sendImpl: async (messages, opts) => {
      await new Promise((_, reject) => {
        if (opts.signal?.aborted) { reject(new Error('aborted before send')); return; }
        opts.signal?.addEventListener('abort', () => reject(new Error('send aborted by stop')), { once: true });
      });
    },
  });
  const h = await launch(t, { fake });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const task = mkTask('task_stopabort', 'waiting_input', conv.json.id, h.server.broker.model);
  await h.server.broker.store.put('alice', 'tasks', task);
  assert.equal(h.server.notifications.enqueueForTask('alice', task), 1);
  const pumping = h.server.notifications.pump();
  const deadline = Date.now() + 5000;
  while (fake.calls < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fake.calls, 1);
  const started = Date.now();
  await h.server.notifications.stop();
  const elapsed = Date.now() - started;
  const out = await pumping;
  assert.ok(elapsed < 2000, `stop must resolve bounded (took ${elapsed}ms)`);
  assert.equal(out.sent, 0);
  assert.notEqual(h.server.db.prepare("SELECT status FROM notification_outbox WHERE task_id = ?").get(task.id).status, 'sent');
});

test('H7.1: receipts poll late; DeviceNotRegistered disables without resending', async (t) => {
  const fake = makeFake();
  const h = await launch(t, { fake });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const task = mkTask('task_receipts', 'waiting_input', conv.json.id, h.server.broker.model);
  await h.server.broker.store.put('alice', 'tasks', task);
  assert.equal(h.server.notifications.enqueueForTask('alice', task), 1);
  const p1 = await h.server.notifications.pump();
  assert.equal(p1.sent, 1);
  const ticket = h.server.db.prepare('SELECT receipt_id FROM notification_outbox WHERE task_id = ?').get(task.id).receipt_id;
  assert.ok(ticket);
  // Receipt not yet available: empty map retries bounded, never resends.
  fake.receipts[ticket] = undefined;
  h.server.db.prepare('UPDATE notification_outbox SET next_receipt_at = 0 WHERE task_id = ?').run(task.id);
  const sendsBefore = fake.sent.length;
  await h.server.notifications.pump();
  assert.equal(fake.sent.length, sendsBefore, 'missing receipt must never resend');
  assert.equal(h.server.db.prepare("SELECT status FROM notification_outbox WHERE task_id = ?").get(task.id).status, 'sent');
  // Provider later reports DeviceNotRegistered: binding disabled, still sent once.
  fake.receipts[ticket] = { status: 'error', message: 'DeviceNotRegistered', details: { error: 'DeviceNotRegistered' } };
  h.server.db.prepare('UPDATE notification_outbox SET next_receipt_at = 0 WHERE task_id = ?').run(task.id);
  await h.server.notifications.pump();
  assert.equal((await h.api('GET', '/v1/notifications/status', { token: alice.token })).json.enabled, false);
  assert.equal(h.server.db.prepare("SELECT receipt_status FROM notification_outbox WHERE task_id = ?").get(task.id).receipt_status, 'error');
  assert.equal(fake.sent.length, sendsBefore, 'receipt errors must never resend');
});

test('H7.1: pending receipts survive restart and resolve without resending', async (t) => {
  const fake = makeFake();
  const h = await launch(t, { fake });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const task = mkTask('task_receipt_restart', 'waiting_input', conv.json.id, h.server.broker.model);
  await h.server.broker.store.put('alice', 'tasks', task);
  assert.equal(h.server.notifications.enqueueForTask('alice', task), 1);
  assert.equal((await h.server.notifications.pump()).sent, 1);
  const sendsBefore = fake.sent.length;
  await h.restart();
  const again = await h.server.notifications.pump();
  assert.equal(fake.sent.length, sendsBefore, 'restart must not resend accepted notifications');
  void again;
});

test('H7.1: retention prunes old transient rows but never task history', async (t) => {
  const fake = makeFake();
  const h = await launch(t, { fake, config: notifConfig({ retentionMs: 2000, outboxMaxRows: 2000, receiptDelayMs: 60000 }) });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const msg = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token, body: { body: 'keep me' } });
  assert.equal(msg.status, 201);
  const old = Date.now() - 10000;
  for (const [id, status] of [['old_sent', 'sent'], ['old_dropped', 'dropped']]) {
    h.server.db.prepare(
      `INSERT INTO notification_outbox(id, event_id, device_id, owner, task_id, conversation_id, kind, expected_status,
       status, attempts, next_attempt_at, last_error, receipt_id, created_at, updated_at, expires_at)
       VALUES(?, ?, ?, ?, ?, NULL, 'completed', 'succeeded', ?, 1, 0, NULL, NULL, ?, ?, ?)`,
    ).run(id, `ev-${id}`, alice.device_id, 'alice', `task-${id}`, status, old, old, old + 1000);
  }
  const live = mkTask('task_retention_live', 'waiting_input', conv.json.id, h.server.broker.model);
  await h.server.broker.store.put('alice', 'tasks', live);
  assert.equal(h.server.notifications.enqueueForTask('alice', live), 1);
  await h.server.notifications.pump();
  assert.equal(h.server.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE id IN ('old_sent','old_dropped')").get().n, 0,
    'expired transient rows must be pruned');
  assert.equal(h.server.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE task_id = ?").get(live.id).n, 1,
    'live rows must survive');
  assert.equal(h.server.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv.json.id).n, 1,
    'task history is never pruned');
});

test('H7.1: receipt sweep is bounded per pump', async (t) => {
  const fake = makeFake();
  const h = await launch(t, { fake, config: notifConfig({ receiptBatch: 2, receiptDelayMs: 0 }) });
  const alice = await h.pairAs('alice');
  await h.api('POST', '/v1/notifications/register', { token: alice.token, body: { expo_push_token: TOKEN_A, permission_enabled: true } });
  const now = Date.now();
  for (let i = 0; i < 4; i++) {
    h.server.db.prepare(
      `INSERT INTO notification_outbox(id, event_id, device_id, owner, task_id, conversation_id, kind, expected_status,
       status, attempts, next_attempt_at, last_error, receipt_id, created_at, updated_at, expires_at,
       lease_id, lease_until, receipt_status, next_receipt_at, receipt_attempts)
       VALUES(?, ?, ?, ?, ?, NULL, 'completed', 'succeeded', 'sent', 0, 0, NULL, ?, ?, ?, ? + 3600000, NULL, 0, 'pending', 0, 0)`,
    ).run(`rcpt-${i}`, `ev-rcpt-${i}`, alice.device_id, 'alice', `task-rcpt-${i}`, `tick-${i}`, now, now, now);
  }
  await h.server.notifications.pump();
  assert.ok(fake.receiptCalls.length >= 1);
  assert.ok(fake.receiptCalls.every((ids) => ids.length <= 2), 'each poll stays within the batch bound');
  const remaining = h.server.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE receipt_status = 'pending'").get().n;
  assert.equal(remaining, 2, 'one pump checks at most receiptBatch rows');
  await h.server.notifications.pump();
  assert.equal(h.server.db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE receipt_status = 'ok'").get().n, 4);
});

test('H7.1: runtime env keeps the model key and FD3 but drops host secrets', async (t) => {
  const source = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/operator',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    HTTPS_PROXY: 'http://proxy:8080',
    ME_RUNTIME_ALLOW_REMOTE: '1',
    ME_RUNTIME_ARGV: '["python3","-m","me_runtime.bridge"]',
    ME_RUNTIME_MODEL_API_KEY: 'live-model-key',
    ME_HOME_TASK_RPC_FD: '9',
    HOME_EXPO_ACCESS_TOKEN: 'expo-admin-secret',
    HOME_NOTIFICATIONS_ENABLED: '1',
    HOME_NOTIF_MAX_ATTEMPTS: '8',
    SSH_AUTH_SOCK: '/tmp/ssh-sentinel',
    SSH_AGENT_PID: '123',
    AWS_SECRET_ACCESS_KEY: 'aws-sentinel',
    AWS_SESSION_TOKEN: 'aws-token-sentinel',
    TUNNEL_TOKEN: 'tunnel-sentinel',
    CLOUDFLARE_API_TOKEN: 'cf-sentinel',
  };
  const env = buildRuntimeEnv(source, { provider: 'openai', model: 'gpt-4o-mini', api_key_env: 'ME_RUNTIME_MODEL_API_KEY' });
  const dumped = JSON.stringify(env);
  assert.ok(!dumped.includes('sentinel'), 'provider/SSH/AWS secrets must be absent');
  assert.ok(!dumped.includes('expo-admin-secret'), 'push admin secret must never cross into the runtime');
  assert.equal(env.ME_RUNTIME_MODEL_API_KEY, 'live-model-key', 'the trusted model key stays available');
  assert.equal(env.ME_RUNTIME_ALLOW_REMOTE, '1');
  assert.equal(env.ME_RUNTIME_ARGV, '["python3","-m","me_runtime.bridge"]');
  assert.equal(env.ME_HOME_TASK_RPC_FD, '3', 'FD3 injected as the trusted value');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/operator');
  // Unknown model key names are ignored, never passed through blindly.
  const bad = buildRuntimeEnv(source, { provider: 'openai', api_key_env: 'evil;name' });
  assert.ok(!('evil;name' in bad));
  // Without a model key the secret stays out even if present in the host env.
  const nokey = buildRuntimeEnv(source, { provider: 'local', model: 'llama3.1' });
  assert.ok(!('ME_RUNTIME_MODEL_API_KEY' in nokey));
});
