import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function launch(t, { seed = ['alice', 'bob'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-h1-'));
  const dbPath = join(dir, 'home.sqlite');
  const start = async () => {
    const server = createHomeServer({ dbPath });
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
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${current.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const pairAs = async (user, label = `${user} phone`, extra = {}) => {
    const inv = createInvitation(current.server.db, user, 60_000);
    const paired = await api('POST', '/v1/pair', {
      body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret, device_label: label, ...extra },
    });
    assert.equal(paired.status, 201);
    const sess = await api('POST', '/v1/sessions', {
      body: { device_id: paired.json.device_id, device_secret: paired.json.device_secret },
    });
    assert.equal(sess.status, 201);
    return { ...paired.json, token: sess.json.token, invitation: inv };
  };
  const restart = async () => {
    await current.server.stop();
    current = await start();
  };
  return { api, pairAs, restart, get base() { return current.base; }, get server() { return current.server; }, dbPath };
}

test('health is anonymous and installation survives restart', async (t) => {
  const h = await launch(t);
  const health = await h.api('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.contract, 'home-api-v1');
  const ready = await h.api('GET', '/readyz');
  assert.equal(ready.status, 200);
  const before = health.json.installation_id;
  await h.restart();
  const after = await h.api('GET', '/healthz');
  assert.equal(after.json.installation_id, before);
});

test('documented CLI bootstrap prints a redeemable invitation', async (t) => {
  const h = await launch(t, { seed: [] });
  const out = execFileSync(
    process.execPath,
    ['--experimental-transform-types', 'src/cli.mjs', 'bootstrap', '--user=alice', `--db=${h.dbPath}`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const inv = JSON.parse(out);
  assert.equal(inv.user_id, 'alice');
  assert.ok(inv.invitation_secret);
  const paired = await h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
  });
  assert.equal(paired.status, 201);
});

test('chat round trip persists across restart without model output', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: { title: 'Trip' } });
  assert.equal(conv.status, 201);
  const msg = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token,
    body: { body: 'hello home' },
  });
  assert.equal(msg.status, 201);
  assert.equal(msg.json.role, 'user');
  assert.equal(msg.json.body, 'hello home');
  assert.equal(msg.json.author_user_id, 'alice');
  await h.restart();
  const again = await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: alice.token });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.messages.map((m) => m.body), ['hello home']);
});

test('cross-user conversation/message access is rejected', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const bob = await h.pairAs('bob');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  assert.equal((await h.api('GET', `/v1/conversations/${conv.json.id}`, { token: bob.token })).status, 404);
  assert.equal((await h.api('GET', `/v1/conversations/${conv.json.id}/messages`, { token: bob.token })).status, 404);
  assert.equal((await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: bob.token, body: { body: 'intrude' },
  })).status, 404);
  const list = await h.api('GET', '/v1/conversations', { token: bob.token });
  assert.deepEqual(list.json.conversations, []);
  assert.equal((await h.api('GET', '/v1/conversations', {})).status, 401);
});

test('expired, wrong-secret, and reused invitations fail', async (t) => {
  const h = await launch(t);
  const expired = createInvitation(h.server.db, 'alice', -1000);
  assert.equal((await h.api('POST', '/v1/pair', {
    body: { invitation_id: expired.invitation_id, invitation_secret: expired.invitation_secret },
  })).status, 410);
  const inv = createInvitation(h.server.db, 'alice', 60_000);
  assert.equal((await h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: 'wrong-secret' },
  })).status, 403);
  const first = await h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
  });
  assert.equal(first.status, 201);
  const reuse = await h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
  });
  assert.equal(reuse.status, 410);
  assert.equal(reuse.json.error.code, 'invitation_consumed');
});

test('two phones racing one invitation enroll at most one', async (t) => {
  const h = await launch(t);
  const inv = createInvitation(h.server.db, 'alice', 60_000);
  const attempt = () => h.api('POST', '/v1/pair', {
    body: { invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret },
  });
  const [a, b] = await Promise.all([attempt(), attempt()]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [201, 410]);
});

test('revocation ends sessions and renewal without touching other devices', async (t) => {
  const h = await launch(t);
  const first = await h.pairAs('alice', 'phone 1');
  const second = await h.pairAs('alice', 'phone 2');
  const revoked = await h.api('POST', `/v1/devices/${first.device_id}/revoke`, { token: first.token });
  assert.equal(revoked.status, 200);
  assert.equal((await h.api('GET', '/v1/me', { token: first.token })).status, 401);
  assert.equal((await h.api('POST', '/v1/sessions', {
    body: { device_id: first.device_id, device_secret: first.device_secret },
  })).status, 401);
  assert.equal((await h.api('GET', '/v1/me', { token: second.token })).status, 200);
  const bob = await h.pairAs('bob');
  assert.equal((await h.api('POST', `/v1/devices/${second.device_id}/revoke`, { token: bob.token })).status, 404);
});

test('non-user roles are rejected: no fabricated model output', async (t) => {
  const h = await launch(t);
  const alice = await h.pairAs('alice');
  const conv = await h.api('POST', '/v1/conversations', { token: alice.token, body: {} });
  const res = await h.api('POST', `/v1/conversations/${conv.json.id}/messages`, {
    token: alice.token,
    body: { body: 'fake assistant reply', role: 'assistant' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'unsupported_role');
});
