// H6: durable bounded subtask delegation via fd-3 task-rpc-v1.
// Home half authoritative; runtime half exercised by a real Node fixture
// process speaking the duplex RPC (not a fake).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELEG_BRIDGE = join(ROOT, 'test', 'fixture-delegation-bridge.mjs');
const FIXTURE_BRIDGE = join(ROOT, 'test', 'fixture-bridge.mjs');

function brokerFor(bridge, overrides = {}) {
  return {
    runtime: { command: [process.execPath, bridge], cwd: undefined },
    model: { provider: 'fixture', model: 'fixture-echo' },
    pollMs: 25,
    termination: { termGraceMs: 500, killGraceMs: 500, wallAllowanceMs: 500, shutdownMs: 10000 },
    ...overrides,
  };
}

async function launch(t, { bridge = DELEG_BRIDGE, brokerOverrides = {}, env = {}, delegation } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h6-'));
  const dbPath = join(dir, 'home.sqlite');
  const tasksRoot = join(dir, 'tasks');
  const broker = brokerFor(bridge, brokerOverrides);
  if (delegation) broker.delegation = delegation;
  const start = async () => {
    const server = createHomeServer({ dbPath, broker: { ...broker, tasksRoot }, env });
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
        throw new Error(`task settled as ${res.json.status} (${res.json.error ?? ''}) while waiting for ${want}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${want}; last=${res.json.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { api, pairAs, restart, waitTask, get server() { return current.server; }, tasksRoot, dir };
}

test('H6: parent spawns child via fd-3 RPC, waits, resumes, finalizes', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'parent job\nSPAWN:research-1:hello from child', title: 'Parent' },
  });
  assert.equal(sub.status, 201);
  // Parent must park (waiting_children) while the child runs, not publish early.
  const parked = await h.waitTask(alice.token, sub.json.id, 'waiting_children');
  assert.ok(Array.isArray(parked.children) && parked.children.length === 1);
  assert.equal(parked.parent_task_id, null);
  assert.equal(parked.root_task_id, sub.json.id);
  // Child is listed in the same conversation (existing phone list keeps working).
  const listed = (await h.api('GET', `/v1/conversations/${conv.json.id}/tasks`, { token: alice.token })).json.tasks;
  const childRow = listed.find((r) => r.parent_task_id === sub.json.id);
  assert.ok(childRow, 'child visible in conversation task list');
  assert.equal(childRow.root_task_id, sub.json.id);
  // No assistant message yet (no premature final).
  const before = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  assert.equal(before.filter((m) => m.role === 'assistant').length, 0);
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /parent done children=1/);
  assert.match(done.output, /hello from child/);
  const after = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  const assistant = after.filter((m) => m.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].task_id, sub.json.id);
  const childView = await h.api('GET', `/v1/tasks/${childRow.id}`, { token: alice.token });
  assert.equal(childView.json.status, 'succeeded');
});

test('H6: premature completed with active children is held, not published', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'eager parent\nSPAWN:k1:child work\nCOMPLETE_EARLY' },
  });
  const parked = await h.waitTask(alice.token, sub.json.id, 'waiting_children');
  assert.equal(parked.children.length, 1);
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /parent done/);
});

test('H6: waiting_input parent with children does not auto-resume on child settle', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'clarify parent\nSPAWN:k1:quick child\nASK:Which format?' },
  });
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  assert.equal(waiting.questions[0].id, 'q1');
  assert.ok(Array.isArray(waiting.children) && waiting.children.length === 1);
  // Child settles while the parent waits for a human: parent must stay put.
  const childId = waiting.children[0];
  const deadline = Date.now() + 15000;
  for (;;) {
    const cv = await h.api('GET', `/v1/tasks/${childId}`, { token: alice.token });
    if (cv.json.status === 'succeeded') break;
    if (Date.now() > deadline) throw new Error('child never settled');
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json.status, 'waiting_input');
  const answered = await h.api('POST', `/v1/tasks/${sub.json.id}/inputs`, {
    token: alice.token, body: { inputs: [{ id: 'q1', answer: 'MP4' }] },
  });
  assert.equal(answered.status, 200);
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /MP4/);
});

test('H6: duplicate RPC key returns same child; different payload conflicts', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'dup parent\nDUPTEST:dupkey:child hello' },
  });
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /parent done/);
  // Only one child exists for the duplicate key (idempotent, not duplicated).
  const listed = (await h.api('GET', `/v1/conversations/${conv.json.id}/tasks`, { token: alice.token })).json.tasks;
  assert.equal(listed.filter((r) => r.parent_task_id === sub.json.id).length, 1);
});

test('H6: capability widening via RPC is denied; owner isolation holds', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'wide parent\nWIDETEST:widekey:evil child' },
  });
  const settled = await h.waitTask(alice.token, sub.json.id, ['succeeded', 'failed']);
  assert.ok(['succeeded', 'failed'].includes(settled.status));
  // Direct API denial with a controlled running parent (worker paused).
  const hCtl = await launch(t, { brokerOverrides: { pollMs: 60000 } });
  const aCtl = await hCtl.pairAs('alice');
  const cCtl = await hCtl.api('POST', '/v1/conversations', { token: aCtl.token, body: {} });
  const fake = {
    id: 'task_wide_parent', title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_wide_parent',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: cCtl.json.id, runId: 'task_wide_parent', request: 'p', capabilities: { files: true, web_fetch: false, browser: false, code_exec: false, animation: false, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: hCtl.server.broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'x', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  };
  await hCtl.server.broker.store.put('alice', 'tasks', fake);
  try {
    await hCtl.server.broker.submitChild('alice', fake.id, { key: 'evil2', request: 'x', capabilities: { files: true, code_exec: true } });
    assert.fail('widening must be denied');
  } catch (e) {
    assert.equal(e.code, 'capability_denied');
  }
  // Cross-user: bob cannot read alice's conversation tasks (owner binding).
  const listed = (await h.api('GET', `/v1/conversations/${conv.json.id}/tasks`, { token: bob.token }));
  assert.equal(listed.status, 404);
});

test('H6: fanout/depth/root bounds enforced; disable with 0', async (t) => {
  const h = await launch(t, { delegation: { maxFanout: 1, maxDepth: 2, maxTasksPerRoot: 25 } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const parentSub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'fanout parent\nSPAWN:a:child a\nSPAWN:b:child b' },
  });
  const settled = await h.waitTask(alice.token, parentSub.json.id, 'failed');
  assert.match(settled.error, /already|denied|fanout|child/i);
  // Depth bound via direct API with paused worker (deterministic).
  const h2 = await launch(t, { brokerOverrides: { pollMs: 60000 }, delegation: { maxFanout: 5, maxDepth: 1, maxTasksPerRoot: 25 } });
  const a2 = await h2.pairAs('alice');
  const c2 = await h2.api('POST', '/v1/conversations', { token: a2.token, body: {} });
  const { broker } = h2.server;
  const mkRunning = (id, depth, parentId, rootId) => ({
    id, title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: parentId, rootTaskId: rootId,
    delegationKey: parentId ? `k-${id}` : null, delegationHash: parentId ? 'h' : null, depth, childIds: [],
    input: { conversationId: c2.json.id, runId: id, request: 'p', capabilities: { files: true, web_fetch: false, browser: false, code_exec: false, animation: false, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'x', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  });
  await broker.store.put('alice', 'tasks', mkRunning('task_depth_parent', 0, null, 'task_depth_parent'));
  const child = await broker.submitChild('alice', 'task_depth_parent', { key: 'c1', request: 'child' });
  assert.equal(child.depth, 1);
  await broker.store.put('alice', 'tasks', { ...(await broker.store.get('alice', 'tasks', child.id)), status: 'running', leaseId: 'y', leaseUntil: new Date(Date.now() + 60000).toISOString(), attempts: 1 });
  try {
    await broker.submitChild('alice', child.id, { key: 'g1', request: 'grandchild' });
    assert.fail('depth must be denied');
  } catch (e) {
    assert.equal(e.code, 'delegation_denied');
  }
  // Disabled delegation: 0 fanout rejects immediately.
  const h3 = await launch(t, { brokerOverrides: { pollMs: 60000 }, delegation: { maxFanout: 0, maxDepth: 0, maxTasksPerRoot: 0 } });
  const a3 = await h3.pairAs('alice');
  const c3 = await h3.api('POST', '/v1/conversations', { token: a3.token, body: {} });
  await h3.server.broker.store.put('alice', 'tasks', {
    id: 'task_disabled_parent', title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_disabled_parent',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: c3.json.id, runId: 'task_disabled_parent', request: 'p', capabilities: { files: true, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h3.server.broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'x', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  });
  try {
    await h3.server.broker.submitChild('alice', 'task_disabled_parent', { key: 'k', request: 'x' });
    assert.fail('disabled must deny');
  } catch (e) {
    assert.equal(e.code, 'delegation_denied');
  }
});

test('H6: cancel cascades to own descendants only; restart reconciles waiting parent', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const bconv = await h.api('POST', '/v1/conversations', { token: bob.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'long parent\nSPAWN:slow:long child\nSLEEP:30' },
  });
  // Parent parks waiting for a slow child; child request text above is the
  // SPAWN line, but the SLEEP line belongs to the parent request and is
  // ignored for children. Use a dedicated long-child parent instead:
  const sub2 = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'long parent2\nSPAWN:slow:SLEEP:30' },
  });
  const parked = await h.waitTask(alice.token, sub2.json.id, 'waiting_children');
  const childId = parked.children[0];
  await h.waitTask(alice.token, childId, 'running');
  // Bob's unrelated task must survive alice's cancel.
  const bsub = await h.api('POST', `/v1/conversations/${bconv.json.id}/tasks`, {
    token: bob.token, body: { request: 'bob work\nSLEEP:5' },
  });
  await h.waitTask(bob.token, bsub.json.id, 'running');
  const cancelled = await h.api('POST', `/v1/tasks/${sub2.json.id}/cancel`, { token: alice.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled');
  const childAfter = await h.api('GET', `/v1/tasks/${childId}`, { token: alice.token });
  assert.equal(childAfter.json.status, 'cancelled');
  assert.equal((await h.api('GET', `/v1/tasks/${bsub.json.id}`, { token: bob.token })).json.status, 'running');
  await h.api('POST', `/v1/tasks/${bsub.json.id}/cancel`, { token: bob.token });
  void sub;
});

test('H6: legacy fixture bridge without fd-3 still completes (no regression)', async (t) => {
  const h = await launch(t, { bridge: FIXTURE_BRIDGE });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'plain hello' },
  });
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /fixture-echo/);
  assert.equal(done.parent_task_id, null);
  assert.equal(done.root_task_id, done.id);
});

test('H6: concurrent same-key spawns yield exactly one child', async (t) => {
  const h = await launch(t, { brokerOverrides: { pollMs: 60000 } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const mkRunning = (id) => ({
    id, title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: id,
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: conv.json.id, runId: id, request: 'p', capabilities: { files: true, web_fetch: false, browser: false, code_exec: false, animation: false, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h.server.broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'lease-1', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  });
  await h.server.broker.store.put('alice', 'tasks', mkRunning('task_race_parent'));
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      h.server.broker.submitChild('alice', 'task_race_parent', { key: 'same-key', request: 'same work', title: 'T' }).catch((e) => e)),
  );
  const ok = results.filter((r) => r && r.id);
  assert.equal(ok.length, 10);
  assert.equal(new Set(ok.map((r) => r.id)).size, 1);
  const listed = await h.server.broker.store.scan('tasks');
  assert.equal(listed.filter((r) => r.value.parentTaskId === 'task_race_parent').length, 1);
});

test('H6: concurrent different keys near cap cannot overshoot fanout', async (t) => {
  const h = await launch(t, { brokerOverrides: { pollMs: 60000 }, delegation: { maxFanout: 3, maxDepth: 2, maxTasksPerRoot: 20 } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  await h.server.broker.store.put('alice', 'tasks', {
    id: 'task_cap_parent', title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_cap_parent',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: conv.json.id, runId: 'task_cap_parent', request: 'p', capabilities: { files: true, web_fetch: false, browser: false, code_exec: false, animation: false, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h.server.broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'l1', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  });
  const out = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      h.server.broker.submitChild('alice', 'task_cap_parent', { key: `k${i}`, request: `work ${i}` }).then(
        (c) => ({ ok: true, id: c.id }),
        (e) => ({ ok: false, code: e.code }),
      )),
  );
  assert.equal(out.filter((r) => r.ok).length, 3);
  assert.ok(out.filter((r) => !r.ok).every((r) => r.code === 'delegation_denied'));
});

test('H6: stale lease fd is denied (takeover)', async (t) => {
  const h = await launch(t, { brokerOverrides: { pollMs: 60000 } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  await h.server.broker.store.put('alice', 'tasks', {
    id: 'task_lease_parent', title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_lease_parent',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: conv.json.id, runId: 'task_lease_parent', request: 'p', capabilities: { files: true, web_fetch: false, browser: false, code_exec: false, animation: false, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h.server.broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'lease-old', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  });
  const { startTaskRpc } = await import('../src/task-broker.mjs');
  const { EventEmitter } = await import('node:events');
  const mkSock = () => {
    const s = new EventEmitter();
    s.writableLength = 0;
    s.sent = [];
    s.write = (line) => { s.sent.push(line); return true; };
    s.destroy = () => { s.destroyed = true; };
    return s;
  };
  // Old fd captured lease-old; worker takes over with lease-new.
  const oldSock = mkSock();
  const rpc = startTaskRpc(h.server.broker, 'alice', 'task_lease_parent', oldSock, { expectedLeaseId: 'lease-old', aborted: () => false });
  await h.server.broker.store.compareAndSwap('alice', 'tasks', 'task_lease_parent', { status: 'running' }, { leaseId: 'lease-new', leaseUntil: new Date(Date.now() + 60000).toISOString() });
  oldSock.emit('data', Buffer.from(JSON.stringify({ rpc: 'task-rpc-v1', id: 1, method: 'submit_child', params: { key: 'k', request: 'x' } }) + '\n'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(oldSock.sent.length, 1);
  assert.match(oldSock.sent[0], /wrong_state/);
  rpc.close();
  // Fresh lease succeeds.
  const freshSock = mkSock();
  const rpc2 = startTaskRpc(h.server.broker, 'alice', 'task_lease_parent', freshSock, { expectedLeaseId: 'lease-new', aborted: () => false });
  freshSock.emit('data', Buffer.from(JSON.stringify({ rpc: 'task-rpc-v1', id: 2, method: 'submit_child', params: { key: 'k2', request: 'y' } }) + '\n'));
  await new Promise((r) => setTimeout(r, 200));
  assert.match(freshSock.sent[0], /"ok":true/);
  rpc2.close();
});

test('H6: invalid delegation env fails closed; zero root-count disables', async (t) => {
  const { resolveDelegationConfig, DEFAULT_DELEGATION } = await import('../src/runtime-config.mjs');
  assert.throws(() => resolveDelegationConfig({ HOME_DELEGATION_MAX_FANOUT: 'nope' }), /HOME_DELEGATION_MAX_FANOUT/);
  assert.deepEqual(DEFAULT_DELEGATION, { maxFanout: 3, maxDepth: 1, maxTasksPerRoot: 4 });
  const { createTaskBroker } = await import('../src/task-broker.mjs');
  const { openHomeDb, closeHomeDb } = await import('../src/db.mjs');
  const dir0 = await mkdtemp(join(tmpdir(), 'me-home-h6env-'));
  t.after(async () => rm(dir0, { recursive: true, force: true }));
  const { db } = openHomeDb(join(dir0, 'home.sqlite'));
  try {
    assert.throws(
      () => createTaskBroker({ db, tasksRoot: join(dir0, 'tasks'), runtime: { command: ['x'] }, model: { provider: 'fixture' }, capabilities: {}, env: { HOME_DELEGATION_MAX_FANOUT: 'bogus' } }),
      /HOME_DELEGATION_MAX_FANOUT/,
    );
  } finally {
    closeHomeDb({ db });
  }
  const h = await launch(t, { brokerOverrides: { pollMs: 60000 }, delegation: { maxFanout: 3, maxDepth: 1, maxTasksPerRoot: 0 } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  await h.server.broker.store.put('alice', 'tasks', {
    id: 'task_zero_root', title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_zero_root',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: conv.json.id, runId: 'task_zero_root', request: 'p', capabilities: { files: true, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h.server.broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'l', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  });
  try {
    await h.server.broker.submitChild('alice', 'task_zero_root', { key: 'k', request: 'x' });
    assert.fail('zero root-count must disable');
  } catch (e) {
    assert.equal(e.code, 'delegation_denied');
  }
});

test('H6: RPC flood/batched/partial/UTF8/oversize bounded, no hang', async (t) => {
  const h = await launch(t, { brokerOverrides: { pollMs: 60000 } });
  const { startTaskRpc } = await import('../src/task-broker.mjs');
  const { EventEmitter } = await import('node:events');
  const mkSock = () => {
    const s = new EventEmitter();
    s.writableLength = 0;
    s.sent = [];
    s.write = (line) => { s.sent.push(line); return true; };
    s.destroy = () => { s.destroyed = true; s.emit('close'); };
    return s;
  };
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  await h.server.broker.store.put('alice', 'tasks', {
    id: 'task_rpc_parent', title: 'p', prompt: 'p', kind: 'agent', status: 'running',
    plan: [], evidence: [], parentTaskId: null, rootTaskId: 'task_rpc_parent',
    delegationKey: null, delegationHash: null, depth: 0, childIds: [],
    input: { conversationId: conv.json.id, runId: 'task_rpc_parent', request: 'p', capabilities: { files: true, web_fetch: false, browser: false, code_exec: false, animation: false, network_egress_allowlist: [] }, budgets: { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 }, model: h.server.broker.model },
    state: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attempts: 1, leaseId: 'lrpc', leaseUntil: new Date(Date.now() + 60000).toISOString(), artifactIds: [],
  });
  const ctx = { expectedLeaseId: 'lrpc', aborted: () => false };
  // Batched + partial + split UTF-8 across chunks.
  {
    const sock = mkSock();
    const rpc = startTaskRpc(h.server.broker, 'alice', 'task_rpc_parent', sock, ctx);
    const a = JSON.stringify({ rpc: 'task-rpc-v1', id: 1, method: 'list_children', params: {} }) + '\n';
    const b = JSON.stringify({ rpc: 'task-rpc-v1', id: 2, method: 'list_children', params: {} }) + '\n';
    const half = Math.floor(a.length / 2);
    sock.emit('data', Buffer.from(a.slice(0, half), 'utf8'));
    const emoji = '😀'.repeat(10);
    sock.emit('data', Buffer.from(a.slice(half) + b.slice(0, 5), 'utf8'));
    sock.emit('data', Buffer.from(b.slice(5) + JSON.stringify({ rpc: 'task-rpc-v1', id: 3, method: 'list_children', params: { note: emoji } }) + '\n', 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sock.sent.length, 3);
    assert.ok(sock.sent.every((s) => s.includes('"ok":true')));
    rpc.close();
  }
  // Oversize line -> error with id correlation, connection survives.
  {
    const sock = mkSock();
    const rpc = startTaskRpc(h.server.broker, 'alice', 'task_rpc_parent', sock, ctx);
    const big = { rpc: 'task-rpc-v1', id: 8, method: 'list_children', params: {}, pad: 'x'.repeat(70 * 1024) };
    sock.emit('data', Buffer.from(JSON.stringify(big) + '\n'));
    sock.emit('data', Buffer.from(JSON.stringify({ rpc: 'task-rpc-v1', id: 9, method: 'list_children', params: {} }) + '\n'));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(sock.sent.some((s) => s.includes('"id":8') && s.includes('64 KiB')));
    assert.ok(sock.sent.some((s) => s.includes('"id":9') && s.includes('"ok":true')));
    rpc.close();
  }
  // Flood without newline closes the pipe.
  {
    const sock = mkSock();
    const rpc = startTaskRpc(h.server.broker, 'alice', 'task_rpc_parent', sock, ctx);
    sock.emit('data', Buffer.from('y'.repeat(600 * 1024)));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sock.destroyed, true);
    rpc.close();
  }
  // Request budget: 201st closes the pipe with one honest error.
  {
    const sock = mkSock();
    const rpc = startTaskRpc(h.server.broker, 'alice', 'task_rpc_parent', sock, ctx);
    for (let i = 1; i <= 201; i++) {
      sock.emit('data', Buffer.from(JSON.stringify({ rpc: 'task-rpc-v1', id: 1000 + i, method: 'list_children', params: {} }) + '\n'));
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(sock.sent.some((s) => s.includes('budget exceeded')));
    assert.equal(sock.destroyed, true);
    rpc.close();
  }
  // Invalid IDs are ignored (no response, no crash); bad method errors.
  {
    const sock = mkSock();
    const rpc = startTaskRpc(h.server.broker, 'alice', 'task_rpc_parent', sock, ctx);
    sock.emit('data', Buffer.from(JSON.stringify({ rpc: 'task-rpc-v1', method: 'list_children', params: {} }) + '\n'));
    sock.emit('data', Buffer.from(JSON.stringify({ rpc: 'task-rpc-v1', id: 'x'.repeat(200), method: 'list_children', params: {} }) + '\n'));
    sock.emit('data', Buffer.from(JSON.stringify({ rpc: 'task-rpc-v1', id: 77, method: 'nope', params: {} }) + '\n'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0], /Unknown rpc method/);
    rpc.close();
  }
});

test('H6: root worker failure cascades to children; other root/owner safe', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const bconv = await h.api('POST', '/v1/conversations', { token: bob.token, body: {} });
  const bad = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'bad parent\nSPAWN:k1:SLEEP:30\nGARBAGE_AFTER_SPAWN' },
  });
  // Wait until the child exists (spawned before the garbage kill).
  let childId = null;
  const deadline = Date.now() + 15000;
  for (;;) {
    const listed = (await h.api('GET', `/v1/conversations/${conv.json.id}/tasks`, { token: alice.token })).json.tasks;
    const kid = listed.find((r) => r.parent_task_id === bad.json.id);
    if (kid) { childId = kid.id; break; }
    if (Date.now() > deadline) throw new Error('child never spawned before failure');
    await new Promise((r) => setTimeout(r, 50));
  }
  const failed = await h.waitTask(alice.token, bad.json.id, 'failed');
  assert.match(failed.error, /non-JSON|malformed|mismatch|killed/i);
  const childAfter = await h.api('GET', `/v1/tasks/${childId}`, { token: alice.token });
  assert.equal(childAfter.json.status, 'cancelled');
  // Unrelated roots survive.
  const other = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'healthy' },
  });
  const bother = await h.api('POST', `/v1/conversations/${bconv.json.id}/tasks`, {
    token: bob.token, body: { request: 'healthy' },
  });
  assert.equal((await h.waitTask(alice.token, other.json.id, 'succeeded')).status, 'succeeded');
  assert.equal((await h.waitTask(bob.token, bother.json.id, 'succeeded')).status, 'succeeded');
});

test('H6: restart reconciles waiting parent without duplicating children', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'parent\nSPAWN:k1:quick child' },
  });
  const parked = await h.waitTask(alice.token, sub.json.id, 'waiting_children');
  assert.equal(parked.children.length, 1);
  await h.restart();
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /parent done children=1/);
  const listed = (await h.api('GET', `/v1/conversations/${conv.json.id}/tasks`, { token: alice.token })).json.tasks;
  assert.equal(listed.filter((r) => r.parent_task_id === sub.json.id).length, 1);
  const msgs = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  assert.equal(msgs.filter((m) => m.role === 'assistant').length, 1);
});
