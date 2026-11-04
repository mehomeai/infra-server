import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkUpstreamId,
  supervisorPathFor,
  seatHeaders,
  supervisorHeaders,
  computerHeaders,
  defaultUpstreamPersonId,
  createSupervisorClient,
  gatewayRequest,
} from '../src/upstream-computer.mjs';

// Exact upstream derivation (supervisor/src/authorisation.ts, names.ts,
// server/src/computer/client.ts + provider.ts). Guards against HMAC guesses.

test('upstream ids follow names.ts rules', () => {
  assert.equal(checkUpstreamId('alice-1_x'), 'alice-1_x');
  for (const bad of ['', 'a/b', 'a.b', 'a:b', 'a b', 'x'.repeat(65), '-lead-ok?no']) {
    if (bad === '-lead-ok?no') continue; // placeholder
    assert.throws(() => checkUpstreamId(bad, 'person'), /id/);
  }
  assert.throws(() => checkUpstreamId('-lead', 'person'), /letter or digit/);
  assert.throws(() => checkUpstreamId(123, 'person'), /required/);
});

test('supervisor paths are whose-computer, never container names', () => {
  assert.equal(supervisorPathFor('person', 'alice'), '/computers/person/alice');
  assert.equal(supervisorPathFor('bot', 'sales-bot'), '/computers/bot/sales-bot');
  assert.throws(() => supervisorPathFor('container', 'x'), /person or a bot/);
  assert.throws(() => supervisorPathFor('person', '../etc'), /letters/);
});

test('supervisor auth is Bearer token, not HMAC', () => {
  assert.deepEqual(supervisorHeaders('tok123'), { authorization: 'Bearer tok123' });
  assert.throws(() => supervisorHeaders(''), /required/);
  assert.throws(() => supervisorHeaders(undefined), /required/);
});

test('computer auth is x-openbot-computer-token + seat headers', () => {
  assert.deepEqual(computerHeaders('ctok', 'bot1', 'alice'), {
    'x-openbot-computer-token': 'ctok',
    'x-openbot-bot-id': 'bot1',
    'x-openbot-person-id': 'alice',
  });
  assert.deepEqual(computerHeaders('ctok', 'bot1'), {
    'x-openbot-computer-token': 'ctok',
    'x-openbot-bot-id': 'bot1',
  });
  assert.throws(() => computerHeaders('', 'b'), /required/);
  assert.deepEqual(seatHeaders('bot1', 'alice'), {
    'x-openbot-bot-id': 'bot1',
    'x-openbot-person-id': 'alice',
  });
});

test('me owner maps 1:1 server-side, never raw client value', () => {
  const mapped = defaultUpstreamPersonId('alice@example.com');
  assert.match(mapped, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  assert.notEqual(mapped, 'alice@example.com');
  // Stable mapping.
  assert.equal(defaultUpstreamPersonId('alice@example.com'), mapped);
});

test('supervisor client ensure/stop/reset/list shapes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method, auth: init?.headers?.authorization });
    if (url.endsWith('/health')) return { json: async () => ({ status: 'ok', docker: true }) };
    if (url.endsWith('/computers')) return { ok: true, json: async () => ({ computers: [] }) };
    return { ok: true, json: async () => ({ kind: 'person', id: 'alice', container: 'c', status: 'running' }) };
  };
  const client = createSupervisorClient({ baseUrl: 'http://127.0.0.1:4500/', token: 'sup-tok', fetchImpl });
  await client.ensurePerson('alice');
  assert.equal(calls[0].url, 'http://127.0.0.1:4500/computers/person/alice/ensure');
  assert.equal(calls[0].auth, 'Bearer sup-tok');
  await client.stop('person', 'alice');
  assert.ok(calls.some((c) => c.url.endsWith('/computers/person/alice/stop')));
  await client.reset('bot', 'b1');
  assert.ok(calls.some((c) => c.url.endsWith('/computers/bot/b1/reset')));
  const listed = await client.list();
  assert.deepEqual(listed, { computers: [] });
});

test('supervisor 401 maps to unauthorized, 503 starting retries', async () => {
  const unauth = createSupervisorClient({
    baseUrl: 'http://x', token: 'bad',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized.' }) }),
  });
  await assert.rejects(() => unauth.list(), /Unauthorized/);
  const starting = createSupervisorClient({
    baseUrl: 'http://x', token: 't',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'slow', starting: true }) }),
  });
  await assert.rejects(() => starting.ensurePerson('alice'), (e) => e.code === 'upstream_starting');
});

test('gateway request shapes server path, never direct computer', () => {
  const req = gatewayRequest({
    gatewayBaseUrl: 'http://up:3001', upstreamSessionToken: 'sess', botId: 'bot1', method: 'POST', path: '/snapshot', body: {},
  });
  assert.equal(req.url, 'http://up:3001/api/computers/bot1/snapshot');
  assert.equal(req.init.headers.authorization, 'Bearer sess');
  assert.throws(() => gatewayRequest({ gatewayBaseUrl: 'http://up', upstreamSessionToken: 's', botId: '../x', path: '/x' }), /id/);
});
