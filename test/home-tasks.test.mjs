import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';
import { openHomeDb } from '../src/db.mjs';
import { validateArtifactPath } from '../src/task-broker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_BRIDGE = join(ROOT, 'test', 'fixture-bridge.mjs');

// Explicitly labeled fixture-model configuration: deterministic offline
// runtime for tests only (HOME_ALLOW_FIXTURE_MODEL is a test-only opt-in).
function fixtureBroker() {
  return {
    runtime: { command: [process.execPath, FIXTURE_BRIDGE], cwd: undefined },
    model: { provider: 'fixture', model: 'fixture-echo' },
    pollMs: 25,
  };
}

async function launch(t, { seed = ['alice', 'bob'], broker = fixtureBroker(), env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h2-'));
  const dbPath = join(dir, 'home.sqlite');
  const tasksRoot = join(dir, 'tasks');
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
  for (const u of seed) ensureUser(current.server.db, u, `${u} (dev fixture)`);
  const api = async (method, path, { token, body, raw } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${current.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const pairAs = async (user, label = `${user} phone`) => {
    const inv = createInvitation(current.server.db, user, 60_000);
    const paired = await api('POST', '/v1/pair', {
      body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret, device_label: label },
    });
    assert.equal(paired.status, 201);
    const sess = await api('POST', '/v1/sessions', {
      body: { device_id: paired.json.device_id, device_secret: paired.json.device_secret },
    });
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
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { api, pairAs, restart, waitTask, get base() { return current.base; }, get server() { return current.server; }, dbPath, tasksRoot, dir };
}

// ---- source-review fixes ----

test('H2 source review: private data dir and database file permissions', async (t) => {
  const h = await launch(t);
  assert.equal(statSync(h.dir).mode & 0o777, 0o700);
  assert.equal(statSync(h.dbPath).mode & 0o777, 0o600);
  assert.equal(statSync(h.tasksRoot).mode & 0o777, 0o700);
});

test('H2 source review: foreign keys enforced and schema version recorded', async (t) => {
  const h = await launch(t);
  assert.equal(h.server.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(h.server.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5');
  // A message for a nonexistent conversation is rejected by the database.
  assert.throws(() => h.server.db.prepare(
    'INSERT INTO messages(id, conversation_id, author_user_id, role, body, created_at) VALUES(?,?,?,?,?,?)',
  ).run('msg_x', 'conv_missing', 'alice', 'user', 'hi', Date.now()));
});

test('H2 source review: unsupported schema version refuses to open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h2ver-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, 'home.sqlite'));
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES('schema_version', '999');`);
  db.close();
  assert.throws(() => openHomeDb(join(dir, 'home.sqlite')), /schema_version/);
});

test('H2 source review: H1 database migrates to v3 with request keys and task binding', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h2mig-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'home.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, author_user_id TEXT NOT NULL, author_device_id TEXT, role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO meta(key, value) VALUES('schema_version', '1');
    INSERT INTO meta(key, value) VALUES('installation_id', 'keep-me');
    INSERT INTO users VALUES('alice', 'alice', 1);
    INSERT INTO conversations VALUES('conv_old', 'alice', 'Old', 1, 1);
    INSERT INTO messages VALUES('msg_old', 'conv_old', 'alice', NULL, 'user', 'legacy', 1);`);
  old.close();
  const { db, installationId } = openHomeDb(path);
  try {
    assert.equal(installationId, 'keep-me');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5');
    assert.equal(db.prepare('SELECT body FROM messages WHERE id = ?').get('msg_old').body, 'legacy');
    db.prepare('INSERT INTO messages(id, conversation_id, author_user_id, role, body, request_key, created_at) VALUES(?,?,?,?,?,?,?)')
      .run('msg_new', 'conv_old', 'alice', 'user', 'keyed', '123e4567-e89b-42d3-a456-426614174000', 2);
  } finally {
    db.close();
  }
});

test('H2 source review: identifiers are full UUIDs', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  assert.match(conv.json.id, /^conv_[0-9a-f-]{36}$/);
  const msg = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token, body: { body: 'hi' },
  });
  assert.match(msg.json.id, /^msg_[0-9a-f-]{36}$/);
  assert.match(alice.device_id, /^dev_[0-9a-f-]{36}$/);
});

test('H2 source review: sessions route is credential-authenticated, not Bearer-authenticated', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  // A bogus Bearer token alongside valid device credentials still succeeds:
  // this route mints sessions and does not consume them.
  const res = await fetch(`${h.base}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ht1_bogus' },
    body: JSON.stringify({ device_id: alice.device_id, device_secret: alice.device_secret }),
  });
  assert.equal(res.status, 201);
});

test('H2 source review: CLI validates port, TTL, and user input', async (t) => {
  const h = await launch(t);
  const run = (args) => {
    try {
      execFileSync(process.execPath, ['--experimental-transform-types', 'src/cli.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(run(['start', `--db=${h.dbPath}`, '--port=99999']), 2);
  assert.equal(run(['start', `--db=${h.dbPath}`, '--port=abc']), 2);
  assert.equal(run(['bootstrap', `--db=${h.dbPath}`, '--user=bad user!']), 2);
  assert.equal(run(['bootstrap', `--db=${h.dbPath}`, '--user=alice', '--ttl-ms=-5']), 2);
  assert.equal(run(['bootstrap', `--db=${h.dbPath}`]), 2);
});

test('H2: idempotent message submission with caller request key', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const key = '123e4567-e89b-42d3-a456-426614174001';
  const first = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token, body: { body: 'retry me', request_key: key },
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.duplicate, false);
  assert.equal(first.json.request_key, key);
  const retry = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token, body: { body: 'retry me', request_key: key },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.id, first.json.id);
  const clash = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token, body: { body: 'different payload', request_key: key },
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, 'request_key_conflict');
  const bad = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token, body: { body: 'x', request_key: 'not-a-uuid' },
  });
  assert.equal(bad.status, 400);
  // Same key in another conversation is independent.
  const conv2 = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const other = await h.api('POST', `/v1/conversations/${conv2.json.id}/messages`, {
    token: alice.token, body: { body: 'retry me', request_key: key },
  });
  assert.equal(other.status, 201);
  assert.notEqual(other.json.id, first.json.id);
});

// ---- task API ----

test('H2: task submit requires home-selected model; client overrides denied', async (t) => {
  const h = await launch(t, { broker: { ...fixtureBroker(), model: null, modelError: 'No model configured' } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const unconfigured = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'do work' },
  });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.json.error.code, 'model_not_configured');
  const override = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'do work', model: { provider: 'fixture' } },
  });
  assert.equal(override.status, 400);
  assert.equal(override.json.error.code, 'model_override_denied');
});

test('H2: fixture task completes with honest output, artifacts, and no home paths', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'make a summary\nARTIFACT:notes.md:hello world', title: 'Notes' },
  });
  assert.equal(sub.status, 201);
  // The worker may already have claimed the task by the time we read it.
  assert.ok(['queued', 'running'].includes(sub.json.status), `unexpected status ${sub.json.status}`);
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /fixture-echo/);
  assert.equal(done.artifacts.length, 1);
  assert.equal(done.artifacts[0].name, 'output/notes.md');
  assert.ok(!JSON.stringify(done).includes(h.tasksRoot), 'home paths must not leak via task API');
  const content = await h.api('GET', `/v1/tasks/${sub.json.id}/artifacts/${done.artifacts[0].id}`, { token: alice.token });
  assert.equal(content.status, 200);
  assert.equal(content.text, 'hello world');
  assert.equal(content.headers.get('content-type'), 'application/octet-stream');
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(done.progress.length > 0);
});

test('H2: waiting input survives restart and resumes via answers', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'draft\nASK:Which format?' },
  });
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_input');
  assert.equal(waiting.questions[0].id, 'q1');
  await h.restart();
  const still = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
  assert.equal(still.json.status, 'waiting_input');
  const answered = await h.api('POST', `/v1/tasks/${sub.json.id}/inputs`, {
    token: alice.token, body: { inputs: [{ id: 'q1', answer: 'MP4' }] },
  });
  assert.equal(answered.status, 200);
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.match(done.output, /MP4/);
  const wrong = await h.api('POST', `/v1/tasks/${sub.json.id}/inputs`, {
    token: alice.token, body: { inputs: [{ id: 'q1', answer: 'late' }] },
  });
  assert.equal(wrong.status, 409);
});

test('H2: approval gate blocks until decided; reject fails honestly', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'send it\nAPPROVE:send email' },
  });
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_approval');
  // Public approval IDs are namespaced per task (H3): never the raw runtime id.
  const publicId = waiting.pending_approvals[0].id;
  assert.ok(publicId.startsWith(`${sub.json.id}:`), publicId);
  assert.notEqual(publicId, 'a1');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json.status, 'waiting_approval');
  const approved = await h.api('POST', `/v1/tasks/${sub.json.id}/approvals`, {
    token: alice.token, body: { approvals: [{ id: publicId, decision: 'approve' }] },
  });
  assert.equal(approved.status, 200);
  const doneApprove = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  // Approval resumes with the original narrow capabilities — never widened.
  assert.deepEqual(doneApprove.capabilities, { files: true, web_fetch: false, browser: false, code_exec: false, animation: false, network_egress_allowlist: [] });
  const sub2 = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'send it\nAPPROVE:send email' },
  });
  const waiting2 = await h.waitTask(alice.token, sub2.json.id, 'waiting_approval');
  const publicId2 = waiting2.pending_approvals[0].id;
  assert.notEqual(publicId2, publicId);
  await h.api('POST', `/v1/tasks/${sub2.json.id}/approvals`, {
    token: alice.token, body: { approvals: [{ id: publicId2, decision: 'reject' }] },
  });
  const rejected = await h.waitTask(alice.token, sub2.json.id, 'failed');
  assert.match(rejected.error, /reject/);
});

test('H2: cancelling a running task terminates the child without resurrection', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'long job\nSLEEP:30' },
  });
  await h.waitTask(alice.token, sub.json.id, 'running');
  const cancelled = await h.api('POST', `/v1/tasks/${sub.json.id}/cancel`, { token: alice.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json.status, 'cancelled');
  assert.equal(h.server.broker.children.size, 0);
});

test('H2: restart during a run marks interrupted instead of replaying', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'long job\nSLEEP:30' },
  });
  await h.waitTask(alice.token, sub.json.id, 'running');
  await h.restart();
  const after = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
  assert.equal(after.json.status, 'failed');
  assert.match(after.json.error, /restarted|interrupted/);
  const attempts = after.json.attempts;
  await new Promise((r) => setTimeout(r, 400));
  const later = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
  assert.equal(later.json.attempts, attempts);
  assert.equal(later.json.status, 'failed');
});

test('H2: cross-user task isolation', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'private\nARTIFACT:secret.md:shh' },
  });
  await h.waitTask(alice.token, sub.json.id, 'succeeded');
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: bob.token })).status, 404);
  assert.equal((await h.api('POST', `/v1/tasks/${sub.json.id}/cancel`, { token: bob.token })).status, 404);
  assert.equal((await h.api('GET', `/v1/conversations/${conv.json.id}/tasks`, { token: bob.token })).status, 404);
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}/artifacts`, { token: bob.token })).status, 404);
  const artId = (await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json.artifacts[0].id;
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}/artifacts/${artId}`, { token: bob.token })).status, 404);
});

test('H2: capability widening requires home opt-in; narrowing is allowed', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const submit = (capabilities) => h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'x', capabilities },
  });
  assert.equal((await submit({ code_exec: true })).json.error.code, 'capability_denied');
  assert.equal((await submit({ web_fetch: true })).json.error.code, 'capability_denied');
  assert.equal((await submit({ no_such_thing: true })).json.error.code, 'capability_denied');
  const narrowed = await submit({ files: false });
  assert.equal(narrowed.status, 201);
  await h.waitTask(alice.token, narrowed.json.id, 'succeeded');
});

test('H2: honest failures, no fake output; bridge spawn errors surface', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'broken\nFAIL:boom message' },
  });
  const failed = await h.waitTask(alice.token, sub.json.id, 'failed');
  assert.match(failed.error, /boom message/);
  assert.equal(failed.output, undefined);
  const bad = await launch(t, {
    broker: { ...fixtureBroker(), runtime: { command: ['/nonexistent-bridge'], cwd: undefined } },
  });
  const balice = await bad.pairAs('alice');
  const bconv = await bad.api('POST', '/v1/conversations', { token: balice.token, body: {} });
  const bsub = await bad.api('POST', `/v1/conversations/${bconv.json.id}/tasks`, {
    token: balice.token, body: { request: 'x' },
  });
  const bfailed = await bad.waitTask(balice.token, bsub.json.id, 'failed');
  assert.match(bfailed.error, /spawn|ENOENT/i);
});

test('H2: artifact paths are jailed to the workspace', async () => {
  const ws = '/home/data/tasks/task_x';
  assert.ok(validateArtifactPath(ws, 'output/notes.md').ok);
  for (const bad of ['../evil', '/abs/path', '..\\evil', '.me_runtime/x', '', 'output/../../evil']) {
    assert.equal(validateArtifactPath(ws, bad).ok, false, bad);
  }
});

// ---- H3 hardening ----

test('H3: adversarial capability and budget shapes are rejected over HTTP', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const submit = (patch) => h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'x', ...patch },
  });
  for (const capabilities of [
    { code_exec: 'true' }, { code_exec: 1 }, { code_exec: ['yes'] }, { code_exec: {} },
    { files: 'yes' }, { files: 0 }, { web_fetch: 1 },
    { no_such_thing: true }, 'admin', ['code_exec'], 42,
    { network_egress_allowlist: 'example.com' },
    { network_egress_allowlist: [42] },
    { network_egress_allowlist: ['evil.example'] },
  ]) {
    const res = await submit({ capabilities });
    assert.equal(res.status, 400, JSON.stringify(capabilities));
    assert.equal(res.json.error.code, 'capability_denied', JSON.stringify(capabilities));
  }
  for (const budgets of ['unlimited', 42, [{ max_steps: 1 }], { max_steps: '10' }, { max_steps: 0 }, { max_steps: 9999 }, { max_steps: 1.5 }, { unknown_budget: 1 }]) {
    const res = await submit({ budgets });
    assert.equal(res.status, 400, JSON.stringify(budgets));
    assert.equal(res.json.error.code, 'bad_request', JSON.stringify(budgets));
  }
  // Sane narrowing still works through the same route.
  const ok = await submit({ capabilities: { files: true, web_fetch: false }, budgets: { max_steps: 2 } });
  assert.equal(ok.status, 201);
  await h.waitTask(alice.token, ok.json.id, 'succeeded');
});

test('H3: structured argv config and remote provider passthrough', async (t) => {
  const { resolveRuntimeCommand, resolveModelConfig } = await import('../src/runtime-config.mjs');
  assert.deepEqual(
    resolveRuntimeCommand({ ME_RUNTIME_ARGV: '["/opt/my dir/py", "-m", "x"]' }).command,
    ['/opt/my dir/py', '-m', 'x'],
  );
  for (const bad of ['not json', '{"a":1}', '[]', '[""]', '[42]', '""']) {
    assert.throws(() => resolveRuntimeCommand({ ME_RUNTIME_ARGV: bad }), /ME_RUNTIME_ARGV/);
  }
  assert.throws(() => resolveRuntimeCommand({ ME_RUNTIME_CMD: 'run "my prog" --x' }), /ME_RUNTIME_ARGV/);
  assert.deepEqual(resolveRuntimeCommand({ ME_RUNTIME_CMD: 'python3 -m me_runtime.bridge' }).command, ['python3', '-m', 'me_runtime.bridge']);
  const remote = resolveModelConfig({ HOME_MODEL_PROVIDER: 'openai', ME_RUNTIME_ALLOW_REMOTE: '1', ME_RUNTIME_MODEL_API_KEY: 'k', HOME_MODEL_ENDPOINT: 'https://compat.example/v1' });
  assert.equal(remote.provider, 'openai');
  assert.equal(remote.endpoint, 'https://compat.example/v1');
  assert.equal(remote.api_key_env, 'ME_RUNTIME_MODEL_API_KEY');
  const remoteDefault = resolveModelConfig({ HOME_MODEL_PROVIDER: 'anthropic', ME_RUNTIME_ALLOW_REMOTE: '1', ME_RUNTIME_MODEL_API_KEY: 'k' });
  assert.equal(remoteDefault.provider, 'anthropic');
  assert.equal(remoteDefault.endpoint, undefined);
  // Invalid argv surfaces honestly at submit time, not as a fake run.
  const h = await launch(t, { broker: { ...fixtureBroker(), runtimeError: 'ME_RUNTIME_ARGV must be a JSON array of strings' } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const res = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'x' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'runtime_not_configured');
});

test('H3: progress is visible while the child runs, then completes', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'stream it\nSTREAM:20' },
  });
  // Observe progress BEFORE the run finishes: poll until we see a running
  // task that already has persisted progress events.
  const deadline = Date.now() + 30000;
  let sawLive = false;
  for (;;) {
    const view = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
    if (view.json.status === 'running' && (view.json.progress?.length ?? 0) > 0) {
      sawLive = true;
      break;
    }
    if (view.json.status === 'succeeded') break;
    if (['failed', 'cancelled'].includes(view.json.status)) throw new Error(`unexpected ${view.json.status}`);
    if (Date.now() > deadline) throw new Error('timed out waiting for live progress');
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(sawLive, true, 'progress must be persisted while the child is still running');
  await h.waitTask(alice.token, sub.json.id, 'succeeded');
});

test('H3: progress is visible before a waiting child is released', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'think\nASKAFTER:10:Which format?' },
  });
  const deadline = Date.now() + 30000;
  let sawLive = false;
  for (;;) {
    const view = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
    if (view.json.status === 'running' && (view.json.progress?.length ?? 0) > 0) {
      sawLive = true;
    }
    if (view.json.status === 'waiting_input') break;
    if (['failed', 'cancelled', 'succeeded'].includes(view.json.status)) throw new Error(`unexpected ${view.json.status}`);
    if (Date.now() > deadline) throw new Error('timed out waiting for waiting_input');
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(sawLive, true, 'progress must precede the waiting state');
});

test('H3: cancel freezes progress; lost leases cannot write', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'stream it\nSTREAM:100' },
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    const view = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
    if (view.json.status === 'running' && (view.json.progress?.length ?? 0) > 2) break;
    if (Date.now() > deadline) throw new Error('stream never started');
    await new Promise((r) => setTimeout(r, 10));
  }
  await h.api('POST', `/v1/tasks/${sub.json.id}/cancel`, { token: alice.token });
  const frozen = (await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json;
  assert.equal(frozen.status, 'cancelled');
  await new Promise((r) => setTimeout(r, 600));
  const later = (await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json;
  assert.equal(later.status, 'cancelled');
  assert.equal(later.progress.length, frozen.progress.length, 'no writes after the lease was lost');
});

test('H3: malformed and oversized bridge output kills the run honestly', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const garbage = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'x\nGARBAGE:' },
  });
  const gFailed = await h.waitTask(alice.token, garbage.json.id, 'failed');
  assert.match(gFailed.error, /non-JSON|malformed/i);
  const big = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'x\nBIGLINE:' },
  });
  const bFailed = await h.waitTask(alice.token, big.json.id, 'failed');
  assert.match(bFailed.error, /256 KiB|exceeds/i);
  assert.equal(h.server.broker.children.size, 0);
});

test('H3: concurrent approve/reject on one approval decides exactly once', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'send it\nAPPROVE:send email' },
  });
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_approval');
  const publicId = waiting.pending_approvals[0].id;
  const [a, b] = await Promise.all([
    h.api('POST', `/v1/tasks/${sub.json.id}/approvals`, { token: alice.token, body: { approvals: [{ id: publicId, decision: 'approve' }] } }),
    h.api('POST', `/v1/tasks/${sub.json.id}/approvals`, { token: alice.token, body: { approvals: [{ id: publicId, decision: 'reject' }] } }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409]);
  // Deciding again afterwards is a replay: still rejected.
  const replay = await h.api('POST', `/v1/tasks/${sub.json.id}/approvals`, {
    token: alice.token, body: { approvals: [{ id: publicId, decision: 'approve' }] },
  });
  assert.equal(replay.status, 409);
});

test('H3: expired approval records refuse to resume', async (t) => {
  // Slow worker ticks so the decision below deterministically wins the race
  // against the worker's own expiry sweep (covered in the next test).
  const h = await launch(t, { broker: { ...fixtureBroker(), pollMs: 60000 } });
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'send it\nAPPROVE:send email' },
  });
  const waiting = await h.waitTask(alice.token, sub.json.id, 'waiting_approval');
  const publicId = waiting.pending_approvals[0].id;
  // Age the record past expiry directly in the store.
  const action = await h.server.broker.store.get('alice', 'actions', publicId);
  action.expiresAt = new Date(Date.now() - 1000).toISOString();
  await h.server.broker.store.put('alice', 'actions', action);
  const res = await h.api('POST', `/v1/tasks/${sub.json.id}/approvals`, {
    token: alice.token, body: { approvals: [{ id: publicId, decision: 'approve' }] },
  });
  assert.equal(res.status, 409);
  assert.match(res.json.error.message, /expired/i);
  assert.equal((await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token })).json.status, 'waiting_approval');
  // The failed attempt rolled back cleanly: restoring expiry lets a real
  // decision through on the same record.
  const fresh = await h.server.broker.store.get('alice', 'actions', publicId);
  assert.equal(fresh.status, 'awaiting_review');
  fresh.expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await h.server.broker.store.put('alice', 'actions', fresh);
  const retry = await h.api('POST', `/v1/tasks/${sub.json.id}/approvals`, {
    token: alice.token, body: { approvals: [{ id: publicId, decision: 'approve' }] },
  });
  assert.equal(retry.status, 200);
  await h.waitTask(alice.token, sub.json.id, 'succeeded');
});

test('H3: worker-expired approvals fail honestly instead of replaying', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'send it\nAPPROVE:send email' },
  });
  await h.waitTask(alice.token, sub.json.id, 'waiting_approval');
  // Age the record; the worker's own expiry sweep retires it, and the home
  // must fail the orphaned run instead of re-executing the gated action.
  const waiting = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
  const publicId = waiting.json.pending_approvals[0].id;
  const action = await h.server.broker.store.get('alice', 'actions', publicId);
  action.expiresAt = new Date(Date.now() - 1000).toISOString();
  await h.server.broker.store.put('alice', 'actions', action);
  const failed = await h.waitTask(alice.token, sub.json.id, 'failed');
  assert.match(failed.error, /without fresh inbox decisions/i);
});

test('H3: completed output is published as an assistant message exactly once', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'say hi' },
  });
  const done = await h.waitTask(alice.token, sub.json.id, 'succeeded');
  const messages = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  const assistant = messages.filter((m) => m.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].body, done.output);
  assert.equal(assistant[0].task_id, sub.json.id);
  assert.equal(assistant[0].author_device_id, null);
  // Restart recovery must not duplicate it.
  await h.restart();
  const again = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  assert.equal(again.filter((m) => m.role === 'assistant').length, 1);
  // Deleting it triggers an idempotent backfill on the next boot.
  h.server.db.prepare("DELETE FROM messages WHERE task_id = ? AND role = 'assistant'").run(sub.json.id);
  await h.restart();
  const backfilled = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  assert.equal(backfilled.filter((m) => m.role === 'assistant').length, 1);
  // A second restart still leaves exactly one.
  await h.restart();
  const stable = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  assert.equal(stable.filter((m) => m.role === 'assistant').length, 1);
});

test('H3: failed and cancelled tasks leave no assistant message', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'broken\nFAIL:boom' },
  });
  await h.waitTask(alice.token, sub.json.id, 'failed');
  const running = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'long\nSLEEP:30' },
  });
  await h.waitTask(alice.token, running.json.id, 'running');
  await h.api('POST', `/v1/tasks/${running.json.id}/cancel`, { token: alice.token });
  await h.waitTask(alice.token, running.json.id, 'cancelled');
  const messages = (await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token })).json.messages;
  assert.equal(messages.filter((m) => m.role === 'assistant').length, 0);
  // The public message route still permits user role only and no task binding.
  const forged = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token, body: { body: 'fake assistant', role: 'assistant' },
  });
  assert.equal(forged.status, 400);
  const bound = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token, body: { body: 'fake binding', task_id: running.json.id },
  });
  assert.equal(bound.status, 400);
});

test('H4: HOME_MODEL_USE_RESPONSES_API parsing and openai-only passthrough', async (t) => {
  const { resolveModelConfig } = await import('../src/runtime-config.mjs');
  const openai = (extra = {}) => resolveModelConfig({
    HOME_MODEL_PROVIDER: 'openai',
    ME_RUNTIME_ALLOW_REMOTE: '1',
    ME_RUNTIME_MODEL_API_KEY: 'k',
    ...extra,
  });
  assert.equal(openai({ HOME_MODEL_USE_RESPONSES_API: '1' }).use_responses_api, true);
  assert.equal(openai({ HOME_MODEL_USE_RESPONSES_API: 'true' }).use_responses_api, true);
  assert.equal(openai({ HOME_MODEL_USE_RESPONSES_API: 'TRUE' }).use_responses_api, true);
  assert.equal('use_responses_api' in openai({}), false);
  assert.equal('use_responses_api' in openai({ HOME_MODEL_USE_RESPONSES_API: '0' }), false);
  assert.equal('use_responses_api' in openai({ HOME_MODEL_USE_RESPONSES_API: 'false' }), false);
  assert.equal(openai({ HOME_MODEL_USE_RESPONSES_API: '1' }).provider, 'openai');
  for (const bad of ['yes', '2', 'on']) {
    assert.throws(() => openai({ HOME_MODEL_USE_RESPONSES_API: bad }), /HOME_MODEL_USE_RESPONSES_API/);
  }
  // Non-openai providers never carry the flag (runtime honors it for openai).
  const local = resolveModelConfig({ HOME_MODEL_PROVIDER: 'local', HOME_MODEL_USE_RESPONSES_API: '1' });
  assert.equal('use_responses_api' in local, false);
  // And it is never client-controlled: the submit route rejects any `model`.
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const res = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'x', model: { provider: 'openai', use_responses_api: true } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'model_override_denied');
  // A home-configured openai model carrying the flag is stored and echoed
  // verbatim into the bridge request (the bridge records model_not_configured
  // honestly here because no live provider is reachable in tests).
  const h2 = await launch(t, {
    broker: {
      ...fixtureBroker(),
      model: { provider: 'openai', model: 'synthetic', api_key_env: 'ME_RUNTIME_MODEL_API_KEY', use_responses_api: true },
    },
  });
  const bob = await h2.pairAs('alice');
  const conv2 = await h2.api('POST', '/v1/conversations', { token: bob.token, body: {} });
  const sub2 = await h2.api('POST', `/v1/conversations/${conv2.json.id}/tasks`, {
    token: bob.token, body: { request: 'x' },
  });
  assert.equal(sub2.status, 201);
  assert.equal(sub2.json.model.use_responses_api, true);
  assert.equal(sub2.json.model.provider, 'openai');
});
