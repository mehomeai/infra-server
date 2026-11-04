// CORS exact-origin allowlist (Codex autosync plan step 6).
// Requires: ME_CORS_ALLOWED_ORIGINS lists serialized origins verbatim;
// only an exact Origin match is granted (never a wildcard, never with
// Access-Control-Allow-Credentials — clients authenticate with an
// explicit Authorization: Bearer ht1_... header, not cookies). Unset
// env = no CORS headers at all (fail-closed, the historical behavior).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHomeServer, ensureUser, createInvitation } from '../src/server.mjs';

const ALLOWED = 'https://preview-abc123.spock.replit.dev';
const OTHER_ALLOWED = 'https://personal-ai-showcase.example.replit.app';
const EVIL = 'https://evil.example.test';

async function launch(t, corsEnv) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-cors-'));
  const env = { ...process.env };
  if (corsEnv === undefined) delete env.ME_CORS_ALLOWED_ORIGINS;
  else env.ME_CORS_ALLOWED_ORIGINS = corsEnv;
  const server = createHomeServer({ dbPath: join(dir, 'home.sqlite'), env });
  const info = await server.start({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    try { await server.stop(); } catch { /* already stopped */ }
    await rm(dir, { recursive: true, force: true });
  });
  return { server, base: `http://${info.host}:${info.port}` };
}

function preflight(base, origin, path = '/v1/me') {
  return fetch(`${base}${path}`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
}

function assertNoCors(res) {
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.headers.get('access-control-allow-methods'), null);
}

test('allowed origin preflight grants exact origin, methods, headers', async (t) => {
  const { base } = await launch(t, `${ALLOWED}, ${OTHER_ALLOWED}`);
  const res = await preflight(base, ALLOWED);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
  const methods = res.headers.get('access-control-allow-methods') ?? '';
  for (const m of ['GET', 'POST']) assert.ok(methods.includes(m), `methods include ${m}`);
  const headers = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  assert.ok(headers.includes('authorization'));
  assert.ok(headers.includes('content-type'));
  assert.equal(res.headers.get('access-control-max-age'), '600');
  assert.match(res.headers.get('vary') ?? '', /origin/i);
  // Header-token auth only: credentialed CORS mode is never granted.
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

test('preflight succeeds without a session (negotiation precedes auth)', async (t) => {
  const { base } = await launch(t, ALLOWED);
  const res = await preflight(base, ALLOWED, '/v1/conversations');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED);
});

test('disallowed origin preflight grants nothing', async (t) => {
  const { base } = await launch(t, ALLOWED);
  const res = await preflight(base, EVIL);
  assert.equal(res.status, 403);
  assertNoCors(res);
});

test('near-miss origins do not match (subdomain, scheme, port, suffix)', async (t) => {
  const { base } = await launch(t, ALLOWED);
  for (const origin of [
    'https://sub.preview-abc123.spock.replit.dev',
    'http://preview-abc123.spock.replit.dev',
    'https://preview-abc123.spock.replit.dev:8443',
    'https://preview-abc123.spock.replit.dev.evil.test',
  ]) {
    const res = await preflight(base, origin);
    assert.equal(res.status, 403, origin);
    assertNoCors(res);
  }
});

test('allowed origin sees CORS headers on actual responses, including 401', async (t) => {
  const { server, base } = await launch(t, ALLOWED);

  const health = await fetch(`${base}/healthz`, { headers: { origin: ALLOWED } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), ALLOWED);
  await health.arrayBuffer();

  const denied = await fetch(`${base}/v1/me`, { headers: { origin: ALLOWED } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), ALLOWED);
  assert.match(denied.headers.get('vary') ?? '', /origin/i);
  await denied.arrayBuffer();

  // Positive control: pair + session, then an authorized actual request.
  ensureUser(server.db, 'alice', 'Alice (dev fixture)');
  const inv = createInvitation(server.db, 'alice', 60_000);
  const paired = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ALLOWED },
    body: JSON.stringify({ invitation_id: inv.invitation_id, invitation_secret: inv.invitation_secret, device_label: 'phone' }),
  });
  assert.equal(paired.status, 201);
  assert.equal(paired.headers.get('access-control-allow-origin'), ALLOWED);
  const pairBody = await paired.json();
  const sess = await fetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: pairBody.device_id, device_secret: pairBody.device_secret }),
  });
  assert.equal(sess.status, 201);
  const { token } = await sess.json();
  const me = await fetch(`${base}/v1/me`, {
    headers: { origin: ALLOWED, authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('access-control-allow-origin'), ALLOWED);
  await me.arrayBuffer();
});

test('actual request from a disallowed origin is processed but gets no CORS headers', async (t) => {
  const { base } = await launch(t, ALLOWED);
  const res = await fetch(`${base}/healthz`, { headers: { origin: EVIL } });
  assert.equal(res.status, 200);
  assertNoCors(res);
  await res.arrayBuffer();
});

test('requests without an Origin header are unchanged', async (t) => {
  const { base } = await launch(t, ALLOWED);
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assertNoCors(res);
  await res.arrayBuffer();
});

test('unset allowlist emits no CORS headers and preflight is not granted', async (t) => {
  const { base } = await launch(t, undefined);
  const res = await fetch(`${base}/healthz`, { headers: { origin: ALLOWED } });
  assert.equal(res.status, 200);
  assertNoCors(res);
  await res.arrayBuffer();

  const pre = await preflight(base, ALLOWED);
  assert.notEqual(pre.status, 204); // falls through to the session-auth gate
  assertNoCors(pre);
  await pre.arrayBuffer();
});

test('malformed allowlist entries fail loudly at startup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-cors-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const bad of ['*', 'https://example.com/path', 'example.com', 'https://example.com/']) {
    assert.throws(
      () => createHomeServer({ dbPath: join(dir, 'home.sqlite'), env: { ...process.env, ME_CORS_ALLOWED_ORIGINS: bad } }),
      /ME_CORS_ALLOWED_ORIGINS/,
      bad,
    );
  }
});
