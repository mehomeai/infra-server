// H5 regression suite: bounded supervision, auth rate limiting, artifact
// ingest hardening, native local endpoint. Uses the labeled fixture bridge;
// R2 signal coverage lives in the test below via the real bridge.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';import { resolveModelConfig } from '../src/runtime-config.mjs';
import { createRateLimiter, clientIp } from '../src/rate-limit.mjs';
import { ingestArtifact } from '../src/task-broker.mjs';
import { openHomeDb } from '../src/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_BRIDGE = join(ROOT, 'test', 'fixture-bridge.mjs');

function fixtureBroker(overrides = {}) {
  return {
    runtime: { command: [process.execPath, FIXTURE_BRIDGE], cwd: undefined },
    model: { provider: 'fixture', model: 'fixture-echo' },
    pollMs: 25,
    termination: { termGraceMs: 500, killGraceMs: 500, wallAllowanceMs: 500, shutdownMs: 10000 },
    ...overrides,
  };
}

async function launch(t, { seed = ['alice', 'bob'], broker = fixtureBroker(), rateLimit, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h5-'));
  const dbPath = join(dir, 'home.sqlite');
  const tasksRoot = join(dir, 'tasks');
  const start = async () => {
    const server = createHomeServer({ dbPath, broker: { ...broker, tasksRoot }, rateLimit, env });
    const info = await server.start({ host: '127.0.0.1', port: 0 });
    return { server, base: `http://${info.host}:${info.port}` };
  };
  let current = await start();
  t.after(async () => {
    try { await current.server.stop(); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });
  for (const u of seed) ensureUser(current.server.db, u, `${u} (dev fixture)`);
  const api = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const res = await fetch(`${current.base}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text, headers: res.headers };
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
  return { api, pairAs, restart, waitTask, get base() { return current.base; }, get server() { return current.server; }, dbPath, tasksRoot, dir };
}

test('H5: bounded shutdown kills a SIGTERM-ignoring child without orphans', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'hang\nSTALL:\nIGNORETERM:' },
  });
  await h.waitTask(alice.token, sub.json.id, 'running');
  const pid = h.server.broker.children.get(sub.json.id)?.pid;
  assert.ok(pid, 'child must be tracked');
  const started = Date.now();
  await h.restart();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 25000, `shutdown+restart must be bounded (took ${elapsed}ms)`);
  assert.equal(h.server.broker.children.size, 0);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'no orphan runtime process may survive');
  const after = await h.api('GET', `/v1/tasks/${sub.json.id}`, { token: alice.token });
  assert.equal(after.json.status, 'failed');
  assert.match(after.json.error, /restarted|interrupted/);
});

test('H5: actual CLI child ignoring SIGTERM still shuts down bounded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h5cli-'));
  const dbPath = join(dir, 'home.sqlite');
  const port = 7199;
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const cli = (args, env = {}) => execFileSync(
    process.execPath,
    ['--experimental-transform-types', 'src/cli.mjs', ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } },
  );
  cli(['seed-dev', `--db=${dbPath}`]);
  const inv = JSON.parse(cli(['bootstrap', '--user=alice', `--db=${dbPath}`]));
  const serverEnv = {
    HOME_MODEL_PROVIDER: 'fixture',
    HOME_ALLOW_FIXTURE_MODEL: '1',
    ME_RUNTIME_ARGV: JSON.stringify(['node', FIXTURE_BRIDGE]),
    HOME_RUNTIME_TERM_GRACE_MS: '500',
    HOME_RUNTIME_KILL_GRACE_MS: '500',
    HOME_SHUTDOWN_MS: '10000',
  };
  const proc = spawn(process.execPath, ['--experimental-transform-types', 'src/cli.mjs', 'start', `--db=${dbPath}`, `--port=${port}`], {
    cwd: ROOT,
    env: { ...process.env, ...serverEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cliOut = '';
  proc.stdout.on('data', (d) => { cliOut += d; });
  proc.stderr.on('data', (d) => { cliOut += d; });
  t.after(() => {
    if (proc.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
    }
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (path, body, token) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  // Wait for the CLI server to listen.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`CLI server never came up:\n${cliOut}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const paired = await post('/v1/pair', { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret });
  assert.equal(paired.status, 201);
  const sess = await post('/v1/sessions', { device_id: paired.json.device_id, device_secret: paired.json.device_secret });
  const token = sess.json.token;
  const convRes = await fetch(`${base}/v1/conversations`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}',
  });
  const conv = await convRes.json();
  const taskRes = await fetch(`${base}/v1/conversations/${conv.id}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ request: 'hang\nSTALL:\nIGNORETERM:' }),
  });
  const task = await taskRes.json();
  const waitDeadline = Date.now() + 30000;
  for (;;) {
    const r = await fetch(`${base}/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${token}` } });
    if ((await r.json()).status === 'running') break;
    if (Date.now() > waitDeadline) throw new Error('stall task never started');
    await new Promise((r) => setTimeout(r, 50));
  }
  // S2's hang: graceful SIGTERM never returned. Bound it.
  const stopStarted = Date.now();
  proc.kill('SIGTERM');
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20000);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const stopElapsed = Date.now() - stopStarted;
  assert.notEqual(exited, false, `CLI must exit on SIGTERM without force-kill:\n${cliOut}`);
  assert.equal(exited, 0);
  assert.ok(stopElapsed < 20000, `shutdown must be bounded (took ${stopElapsed}ms)`);
  // No orphan runtime processes referencing the task workspace (grandchild
  // must have died with the CLI, not lingered).
  const taskWs = join(dir, 'tasks', task.id);
  try {
    const found = execFileSync('pgrep', ['-f', taskWs], { encoding: 'utf8' }).trim();
    assert.equal(found, '', `orphan processes reference ${taskWs}: ${found}`);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log('pgrep unavailable; orphan check skipped (broker-level test covers it)');
    } else if (error?.status === 1) {
      // pgrep exit 1 = no match: the desired outcome.
    } else {
      throw error;
    }
  }
});

test('H5: failed pair/session attempts are rate limited per IP', async (t) => {
  const h = await launch(t, { rateLimit: { maxFailures: 3, windowMs: 60000, maxEntries: 100 } });
  const inv = createInvitation(h.server.db, 'alice', 60_000);
  const badPair = () => h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: 'wrong' },
  });
  assert.equal((await badPair()).status, 403);
  assert.equal((await badPair()).status, 403);
  assert.equal((await badPair()).status, 403);
  const limited = await h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'rate_limited');
  assert.ok(limited.headers.get('retry-after'), '429 carries Retry-After');
  // Sessions route shares the same per-IP limiter instance, so exercise it
  // on a fresh server (fresh bucket) for an independent assertion.
  const h2 = await launch(t, { rateLimit: { maxFailures: 3, windowMs: 60000, maxEntries: 100 } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await h2.api('POST', '/v1/sessions', {
      body: { device_id: 'dev_missing', device_secret: 'x' },
    })).status, 401);
  }
  assert.equal((await h2.api('POST', '/v1/sessions', {
    body: { device_id: 'dev_missing', device_secret: 'x' },
  })).status, 429);
});

test('H5: rate limit window expires and successes reset the bucket', async (t) => {
  const h = await launch(t, { rateLimit: { maxFailures: 2, windowMs: 400, maxEntries: 100 } });
  const inv = createInvitation(h.server.db, 'alice', 60_000);
  const bad = () => h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: 'wrong' },
  });
  assert.equal((await bad()).status, 403);
  assert.equal((await bad()).status, 403);
  assert.equal((await bad()).status, 429);
  await new Promise((r) => setTimeout(r, 500));
  const good = await h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
  });
  assert.equal(good.status, 201);
});

test('H5: rate limiter units — bounds, expiry, proxy trust', () => {
  const limiter = createRateLimiter({ maxFailures: 2, windowMs: 1000, maxEntries: 3 });
  assert.equal(limiter.check('1.2.3.4').limited, false);
  limiter.fail('1.2.3.4', 1000);
  limiter.fail('1.2.3.4', 1001);
  assert.equal(limiter.check('1.2.3.4', 1002).limited, true);
  assert.equal(limiter.check('1.2.3.4', 5000).limited, false, 'window expiry clears');
  limiter.fail('a', 0);
  limiter.fail('b', 0);
  limiter.fail('c', 0);
  limiter.fail('d', 0);
  assert.ok(limiter.size <= 3, 'entries are hard-capped');
  limiter.fail('e', 0);
  limiter.reset('e');
  assert.equal(limiter.check('e', 1).limited, false);
  const direct = { socket: { remoteAddress: '9.9.9.9' }, headers: { 'x-forwarded-for': '1.1.1.1' } };
  assert.equal(clientIp(direct, {}), '9.9.9.9', 'XFF ignored by default');
  const viaLocal = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } };
  assert.equal(clientIp(viaLocal, { HOME_TRUST_PROXY: '1' }), '1.1.1.1');
  assert.equal(clientIp(viaLocal, {}), '127.0.0.1', 'no trust without opt-in');
  const viaRemote = { socket: { remoteAddress: '9.9.9.9' }, headers: { 'x-forwarded-for': '1.1.1.1' } };
  assert.equal(clientIp(viaRemote, { HOME_TRUST_PROXY: '1' }), '9.9.9.9', 'XFF ignored from non-loopback peers');
});

test('H5: local endpoint default is native Ollama (no /v1)', () => {
  assert.equal(resolveModelConfig({ HOME_MODEL_PROVIDER: 'local' }).endpoint, 'http://127.0.0.1:11434');
  assert.equal(
    resolveModelConfig({ HOME_MODEL_PROVIDER: 'local', HOME_MODEL_ENDPOINT: 'http://x:1' }).endpoint,
    'http://x:1',
  );
});

test('H5: symlink and oversized artifacts are rejected, never followed', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const canary = join(h.dir, 'canary.txt');
  await writeFile(canary, 'household-secret');
  const evil = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: `steal\nSYMLINKARTIFACT:link.txt:${canary}` },
  });
  const eFailed = await h.waitTask(alice.token, evil.json.id, 'failed');
  assert.match(eFailed.error, /symlink|escapes/i);
  assert.equal((await h.api('GET', `/v1/tasks/${evil.json.id}/artifacts`, { token: alice.token })).json.artifacts.length, 0);
  const big = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'big\nBIGARTIFACT:big.bin:11534336' },
  });
  const bFailed = await h.waitTask(alice.token, big.json.id, 'failed');
  assert.match(bFailed.error, /too large/i);
  const many = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'many\nMULTIARTIFACT:55:f' },
  });
  const mFailed = await h.waitTask(alice.token, many.json.id, 'failed');
  assert.match(mFailed.error, /too many artifacts/i);
});

test('H5: no cross-workspace read via symlink; aggregate budget enforced', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const first = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'secret\nARTIFACT:secret.txt:topsecret' },
  });
  await h.waitTask(alice.token, first.json.id, 'succeeded');
  const sibling = join(h.tasksRoot, first.json.id, 'output', 'secret.txt');
  assert.ok(existsSync(sibling));
  const second = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: `read other\nSYMLINKARTIFACT:stolen.txt:${sibling}` },
  });
  const sFailed = await h.waitTask(alice.token, second.json.id, 'failed');
  assert.match(sFailed.error, /symlink|escapes/i);
  // Aggregate budget is enforced on top of the per-file cap (unit-level with
  // small limits to avoid writing 100 MB in a test).
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h5ing-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const { db } = openHomeDb(join(dir, 'u.sqlite'));
  ensureUser(db, 'alice', 'alice');
  const ws = join(dir, 'ws');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(ws, 'output'), { recursive: true });
  await writeFile(join(ws, 'output', 'a.txt'), '12345');
  await writeFile(join(ws, 'output', 'b.txt'), '12345');
  const one = ingestArtifact(db, 'alice', 'task_1', ws, { path: 'output/a.txt' }, { maxTotalBytes: 9 });
  assert.equal(one.ok, true);
  const two = ingestArtifact(db, 'alice', 'task_1', ws, { path: 'output/b.txt' }, { maxTotalBytes: 9 });
  assert.equal(two.ok, false);
  assert.match(two.error, /budget/i);
  const three = ingestArtifact(db, 'alice', 'task_1', ws, { path: 'output/a.txt' }, { maxCount: 1 });
  assert.equal(three.ok, false);
  assert.match(three.error, /too many artifacts/i);
  db.close();
});

test('H5: home wall watchdog backstops a runtime that ignores budgets', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const sub = await h.api('POST', `/v1/conversations/${conv.json.id}/tasks`, {
    token: alice.token, body: { request: 'hang\nSLEEP:60', budgets: { max_wall_seconds: 1 } },
  });
  await h.waitTask(alice.token, sub.json.id, 'running');
  // Wall allowance is 500 ms in this harness: the run must die in seconds,
  // not in 60 s, and honestly report the backstop (not fake output).
  const failed = await h.waitTask(alice.token, sub.json.id, 'failed', 20000);
  assert.match(failed.error, /wall budget/i);
  assert.equal(failed.output, undefined);
  assert.equal(h.server.broker.children.size, 0);
});
