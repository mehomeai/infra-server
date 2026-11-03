import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveTracker, probeLiveEvidence } from '../src/upstream-live.mjs';

const ENV = {
  ME_UPSTREAM_MODE: 'full',
  UPSTREAM_SERVER_URL: 'http://127.0.0.1:9',
  DATABASE_URL: 'postgres://u:p@h/db',
  KEY_ENCRYPTION_KEY: 'k'.repeat(44),
  ME_HOME_BRIDGE_SECRET: 'bridge-secret-0123456789abcdef-xyz',
  INTELLIGENCE_API_URL: 'https://i.example',
  INTELLIGENCE_GATEWAY_WS_URL: 'wss://i.example',
  CPK_INTELLIGENCE_API_KEY: 'k',
  BETTER_AUTH_URL: 'http://127.0.0.1:3001',
  BETTER_AUTH_SECRET: 's'.repeat(32),
  INITIAL_ADMIN_EMAILS: 'a@example.com',
  COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
  SUPERVISOR_TOKEN: 's',
  COMPUTER_TOKEN: 'c',
};

function okFetch() {
  return async (url) => {
    const t = String(url);
    const body = t.endsWith('/api/agents')
      ? { agents: [] }
      : t.endsWith('/api/capabilities')
        ? { mode: 'intelligence', durableHistory: true }
        : { status: 'ok' };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
  };
}

test('probe succeeds on healthy stack, refuses config loss and bad auth', async () => {
  const ok = await probeLiveEvidence({ env: ENV, fetchImpl: okFetch() });
  assert.deepEqual(ok, { live: true });
  const noCfg = await probeLiveEvidence({ env: { ...ENV, ME_HOME_BRIDGE_SECRET: '' }, fetchImpl: okFetch() });
  assert.equal(noCfg.live, false);
  assert.equal(noCfg.reason, 'config');
  const down = await probeLiveEvidence({ env: ENV, fetchImpl: async () => { throw new Error('nope'); } });
  assert.deepEqual(down, { live: false, reason: 'unreachable' });
  const refused = await probeLiveEvidence({
    env: ENV,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/agents')) {
        return { ok: false, status: 401, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from('{}') };
      }
      return okFetch()(url);
    },
  });
  assert.deepEqual(refused, { live: false, reason: 'auth' });
});

test('tracker refreshes, singleflights, recovers, and TTL-expires with a fake clock', async (t) => {
  let now = 1_000_000;
  let calls = 0;
  let healthy = true;
  const fetchImpl = async (url) => {
    calls++;
    if (!healthy) throw new Error('down');
    return okFetch()(url);
  };
  const seen = [];
  const tracker = createLiveTracker({
    env: ENV, fetchImpl, intervalMs: 50, ttlMs: 1_000,
    now: () => now, onChange: (s) => seen.push({ ...s }),
  });
  t.after(() => tracker.stop());
  assert.equal(tracker.get().live, false, 'boot is unproven');
  await tracker.refresh();
  assert.equal(tracker.get().live, true, 'healthy refresh proves live');
  const before = calls;
  await Promise.all([tracker.refresh(), tracker.refresh(), tracker.refresh()]);
  assert.ok(calls - before <= 3, `singleflight shares one probe (fetch calls=${calls - before}, one probe makes 3)`);
  healthy = false;
  await tracker.refresh();
  assert.equal(tracker.get().live, false, 'source failure marks not-live');
  assert.equal(tracker.get().reason, 'unreachable');
  healthy = true;
  await tracker.refresh();
  assert.equal(tracker.get().live, true, 'recovery restores live');
  now += 5_000;
  assert.equal(tracker.get().reason, 'stale', 'TTL is hard-bounded even if the loop stalls');
  assert.equal(tracker.get().live, false);
  assert.ok(seen.some((s) => s.live) && seen.some((s) => !s.live), 'change observer fires on transitions');
});

test('tracker seeds from the on-disk cache and writes atomically', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-live-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const cachePath = join(dir, 'doctor-cache.json');
  const { writeDoctorCache } = await import('../src/upstream-doctor.mjs');
  const fs = await import('node:fs');
  writeDoctorCache(cachePath, { state: 'READY', checks: { mode: 'full' } }, { fs, at: 1_000_000, ttlMs: 300_000 });
  // Atomic write leaves no torn file behind.
  assert.ok(!(await import('node:fs/promises').then((m) => m.readdir(dir))).some((f) => f.endsWith('.tmp')));
  const seeded = createLiveTracker({ env: ENV, fetchImpl: okFetch(), now: () => 1_100_000, cachePath, fs });
  t.after(() => seeded.stop());
  assert.equal(seeded.get().live, true, 'restart seeds from last evidence');
  // A successful refresh rewrites the cache file (auxiliary, memory authoritative).
  await seeded.refresh();
  const raw = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(raw.state, 'READY');
  assert.ok(raw.at >= 1_100_000);
});

test('oversize cache file is refused, never trusted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-live-big-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const cachePath = join(dir, 'doctor-cache.json');
  await writeFile(cachePath, `{"protocol":"upstream-platform-v1","state":"READY","pad":"${'x'.repeat(5000)}"}`);
  const tracker = createLiveTracker({ env: ENV, fetchImpl: okFetch(), cachePath });
  t.after(() => tracker.stop());
  assert.equal(tracker.get().live, false);
});
