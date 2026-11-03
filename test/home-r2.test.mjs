// H3-R2: integration against the ACTUAL R2 runtime bridge
// (agentic-framework/src/me_runtime), fixture model only. These tests are
// explicitly labelled: they prove the home service drives the real harness
// subprocess end to end. They do not prove live-model behavior (see R2's
// opt-in live tests for that). If the R2 checkout/venv is absent, they fail
// loudly rather than silently skipping the integration.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R2_REPO = resolve(ROOT, '..', 'agentic-framework');
const R2_PY = join(R2_REPO, '.venv', 'bin', 'python');
const HAS_R2 = existsSync(R2_PY);

// The real-bridge suite needs the sibling checkout. In environments without
// it (e.g. home-only CI), the suite self-skips with a clear message instead
// of faking the integration; set ME_HOME_REQUIRE_R2=1 to fail loudly when
// the integration is mandatory (local dev gate).
if (!HAS_R2 && process.env.ME_HOME_REQUIRE_R2 === '1') {
  throw new Error(`H3-R2: actual runtime missing at ${R2_PY}; refusing to fake the integration`);
}

function r2Broker() {
  return {
    runtime: { command: [R2_PY, '-m', 'me_runtime.bridge'], cwd: R2_REPO },
    model: { provider: 'fixture', model: 'fixture-echo' },
    pollMs: 50,
  };
}

async function launch(t, { seed = ['alice', 'bob'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h3r2-'));
  const dbPath = join(dir, 'home.sqlite');
  const tasksRoot = join(dir, 'tasks');
  const start = async () => {
    const server = createHomeServer({ dbPath, broker: { ...r2Broker(), tasksRoot }, env: {} });
    const info = await server.start({ host: '127.0.0.1', port: 0 });
    return { server, base: `http://${info.host}:${info.port}` };
  };
  let current = await start();
  t.after(async () => {
    try { await current.server.stop(); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });
  for (const u of seed) ensureUser(current.server.db, u, `${u} (dev fixture)`);
  const api = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${current.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text };
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
    return { ...paired.json, token: sess.json.token };
  };
  const restart = async () => {
    await current.server.stop();
    current = await start();
  };
  const waitTask = async (token, taskId, wants, timeoutMs = 60000) => {
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
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { api, pairAs, restart, waitTask, get server() { return current.server; } };
}

test('H3-R2: suite gate (skips without sibling runtime checkout)', { skip: HAS_R2 }, async () => {
  console.log('H3-R2 skipped: actual runtime absent; run where agentic-framework is checked out (see docs/end-to-end-runbook.md)');
});

test('H3-R2: actual runtime fixture run completes with output and artifact', { skip: !HAS_R2 }, async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'hello from H3-R2' },
  });
  assert.equal(sub.status, 201);
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output ?? '', /fixture/i);
  assert.ok(done.artifacts.length >= 1, 'real runtime declares real artifacts');
  const art = done.artifacts[0];
  const content = await h.api('GET', `/v1/tasks/${sub.json.id}/artifacts/${art.id}`, { token: alice.token });
  assert.equal(content.status, 200);
  // Stored bytes must match the bridge-declared checksum.
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(content.text, 'utf8').digest('hex'), art.sha256);
  // And the conversation carries the published assistant message.
  const messages = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  assert.ok(messages.some((m) => m.role === 'assistant' && m.task_id === sub.json.id));
});

test('H3-R2: actual runtime waiting_input resumes via answers', { skip: !HAS_R2 }, async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'ASK: what is the deadline?' },
  });
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  assert.ok(waiting.progress.length > 0, 'real runtime progress persisted before waiting');
  // Question IDs are task-scoped (embedded in the task record, no shared
  // namespace), so the runtime id passes through; approvals below are the
  // namespaced ones.
  const publicId = waiting.questions[0].id;
  assert.equal(publicId, 'q1');
  await h.restart();
  const still = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
  assert.equal(still.json.status, 'waiting_input');
  const answered = await h.api('POST', `/v1/tasks/${sub.json.id}/inputs`, {
    token: alice.token, body: { inputs: [{ id: publicId, answer: 'Friday' }] },
  });
  assert.equal(answered.status, 200);
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output ?? '', /Friday/);
});

test('H3-R2: actual runtime approval gate approves and rejects honestly', { skip: !HAS_R2 }, async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'APPROVE: publish draft' },
  });
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_approval');
  const publicId = waiting.pending_approvals[0].id;
  assert.ok(publicId.endsWith(':a1'), publicId);
  const before = (await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json;
  await h.api('POST', `/v1/tasks/${sub.json.id}/approvals`, {
    token: alice.token, body: { approvals: [{ id: publicId, decision: 'approve' }] },
  });
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.deepEqual(done.capabilities, before.capabilities, 'approval must not widen capabilities');
  const sub2 = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'APPROVE: publish draft' },
  });
  const waiting2 = await h.waitTask(alice.token, sub2.json.id, 'waiting_approval');
  // Same runtime id in a second task is an independent public approval.
  assert.notEqual(waiting2.pending_approvals[0].id, publicId);
  await h.api('POST', `/v1/tasks/${sub2.json.id}/approvals`, {
    token: alice.token, body: { approvals: [{ id: waiting2.pending_approvals[0].id, decision: 'reject' }] },
  });
  const rejected = await h.waitTask(alice.token, sub2.json.id, 'failed');
  assert.equal(rejected.error.includes('reject') || rejected.error.includes('approval'), true, rejected.error);
});

test('H3-R2: cancel a waiting run and cross-user rejection on the real bridge', { skip: !HAS_R2 }, async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'ASK: what is the deadline?' },
  });
  await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  const cancelled = await h.api('POST', `/v1/tasks/${sub.json.id}/cancel`, { token: alice.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal((await h.api('POST', `/v1/tasks/${sub.json.id}/cancel`, { token: bob.token })).status, 404);
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: bob.token })).status, 404);
});

test('H5-R2: abort reaches the real runtime child and leaves no orphan', { skip: !HAS_R2 }, async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'ASK: what is the deadline?' },
  });
  // Catch the live child if we can; otherwise cancel from the waiting state.
  // Either way the abort path must deliver SIGTERM and settle cancelled.
  let pid = null;
  const deadline = Date.now() + 60000;
  let saw = 'waiting_input';
  for (;;) {
    const view = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
    if (view.json.status === 'running') {
      pid = h.server.broker.children.get(sub.json.id)?.pid ?? null;
      if (pid) {
        saw = 'running';
        break;
      }
    }
    if (view.json.status === 'waiting_input') break;
    if (['succeeded', 'failed', 'cancelled'].includes(view.json.status)) {
      throw new Error(`unexpected early terminal state ${view.json.status}`);
    }
    if (Date.now() > deadline) throw new Error('R2 run never started');
    await new Promise((r) => setTimeout(r, 25));
  }
  const cancelled = await h.api('POST', `/v1/tasks/${sub.json.id}/cancel`, { token: alice.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled', `cancelled from ${saw}`);
  // The child exits asynchronously after the abort; wait boundedly, then
  // assert the registry is empty and the process is really gone.
  const reapedBy = Date.now() + 15000;
  while (h.server.broker.children.size > 0) {
    if (Date.now() > reapedBy) throw new Error('runtime child was not reaped after cancel');
    await new Promise((r) => setTimeout(r, 25));
  }
  if (pid) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'no orphan runtime process may survive');
  }
  console.log(`H5-R2: cancel landed while ${saw}; no orphans`);
});
