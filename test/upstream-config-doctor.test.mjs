import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveUpstreamConfig, gateFullConfig } from '../src/upstream-config.mjs';
import { checkUpstreamPlatform } from '../src/upstream-doctor.mjs';
import { verifyHomeAssertion } from '../src/upstream-proxy.mjs';

const BRIDGE = 'bridge-secret-0123456789abcdef-xyz';

// Bounded-probe-shaped stub response: both the legacy .json() readers
// (supervisor client) and the new bounded arrayBuffer() readers (doctor).
function J(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text),
  };
}

function fullEnv(overrides = {}) {
  return {
    ME_UPSTREAM_MODE: 'full',
    UPSTREAM_SERVER_URL: 'http://127.0.0.1:9',
    DATABASE_URL: 'postgres://openbot:x@127.0.0.1:1/openbot',
    KEY_ENCRYPTION_KEY: 'a'.repeat(44),
    ME_HOME_BRIDGE_SECRET: 'bridge-secret-0123456789abcdef-xyz',
    INTELLIGENCE_API_URL: 'https://intel.home.example',
    INTELLIGENCE_GATEWAY_WS_URL: 'wss://intel.home.example',
    CPK_INTELLIGENCE_API_KEY: 'cpk-key',
    COPILOTKIT_LICENSE_TOKEN: 'lic',
    BETTER_AUTH_URL: 'http://localhost:3001',
    BETTER_AUTH_SECRET: 's'.repeat(32),
    INITIAL_ADMIN_EMAILS: 'a@example.com',
    COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
    SUPERVISOR_TOKEN: 's',
    COMPUTER_TOKEN: 'c',
    // Native harness model (single source with the container + tenant file).
    BOT_PROVIDER: 'openai',
    BOT_MODEL: 'llama3.1',
    OPENAI_BASE_URL: 'http://127.0.0.1:11434',
    ...overrides,
  };
}

// Loopback TCP listener standing in for Postgres (proves TCP liveness path).
async function loopbackTcp(t) {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

const okFetch = (extra = {}) => async (url, init) => {
  const target = String(url);
  if (typeof extra === 'function') {
    try {
      return await extra(url, init);
    } catch (error) {
      if (!/unexpected/.test(error.message)) throw error;
    }
  }
  if (target.endsWith('/api/agents')) return J(200, { agents: [{ id: 'bot_help' }] });
  if (target.endsWith('/api/computers/fleet')) {
    // The fake enforces the real gate: user assertions are refused, only a
    // valid admin assertion sees the per-person keyed fleet.
    const who = verifyHomeAssertion(init?.headers?.['x-me-home-assertion'], { bridgeSecret: BRIDGE });
    if (!who) return J(401, { error: 'Authentication required.' });
    if (who.role !== 'admin') return J(403, { error: 'Only an admin can do this.' });
    return J(200, { isolation: 'shared', computers: [{ computer: 'person:u_alice', kind: 'person', personId: 'u_alice', running: false }] });
  }
  if (target.endsWith('/health')) return J(200, { status: 'ok', docker: true });
  if (target.endsWith('/api/capabilities')) return J(200, { mode: 'intelligence', durableHistory: true });
  if (target.endsWith('/api/tags')) {
    return J(200, { models: [{ name: 'llama3.1:latest' }] });
  }
  if (target.endsWith('/computers')) {
    assert.equal(init?.headers?.authorization, 'Bearer s');
    return J(200, { computers: [] });
  }
  if (typeof extra === 'function') return extra(url, init);
  throw new Error(`unexpected fetch ${target}`);
};

const CORE_ENV = {
  ME_UPSTREAM_MODE: 'core',
  COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
  SUPERVISOR_TOKEN: 'sup-token',
  COMPUTER_TOKEN: 'comp-token',
};

test('core resolves without license; missing tokens are NEEDS_INPUT not fallback', async () => {
  const cfg = resolveUpstreamConfig({ ...CORE_ENV });
  assert.equal(cfg.mode, 'core');
  assert.deepEqual(cfg.missing, []);
  const missing = resolveUpstreamConfig({ ME_UPSTREAM_MODE: 'core' });
  assert.ok(missing.missing.includes('COMPUTER_SUPERVISOR_URL'));
  const report = await checkUpstreamPlatform({ env: { ME_UPSTREAM_MODE: 'core' }, probe: false, repoRoot: process.cwd() });
  assert.equal(report.protocol, 'upstream-platform-v1');
  assert.equal(report.state, 'NEEDS_INPUT');
});

test('core doctor READY with stubbed supervisor (pin + token list)', async () => {
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/health')) return { json: async () => ({ status: 'ok', docker: true }) };
    if (String(url).endsWith('/computers')) {
      assert.equal(init?.headers?.authorization, 'Bearer sup-token');
      return { ok: true, json: async () => ({ computers: [] }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const report = await checkUpstreamPlatform({ env: { ...CORE_ENV }, fetchImpl, repoRoot: process.cwd() });
  assert.equal(report.state, 'READY');
  assert.equal(report.checks.sourcePin.ref, '6bfee780c8e8d05141375ea55ebde33eefb3dbc0');
  assert.equal(report.checks.license.required, false);
});

test('supervisor 401 is FAILED, not READY from health proxy', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/health')) return { json: async () => ({ status: 'ok', docker: true }) };
    return J(401, { error: 'Unauthorized.' });
  };
  const report = await checkUpstreamPlatform({ env: { ...CORE_ENV }, fetchImpl, repoRoot: process.cwd() });
  assert.equal(report.state, 'FAILED');
});

test('full gates: SINGLE_USER failed, managed URL failed, missing NEEDS_INPUT', () => {
  const base = {
    ME_UPSTREAM_MODE: 'full',
    DATABASE_URL: 'postgres://x',
    KEY_ENCRYPTION_KEY: 'a'.repeat(44),
    ME_HOME_BRIDGE_SECRET: 'b'.repeat(40),
    INTELLIGENCE_API_URL: 'https://intel.example',
    INTELLIGENCE_GATEWAY_WS_URL: 'wss://intel.example',
    CPK_INTELLIGENCE_API_KEY: 'cpk-key',
    BETTER_AUTH_URL: 'http://localhost:3001',
    BETTER_AUTH_SECRET: 's'.repeat(32),
    INITIAL_ADMIN_EMAILS: 'a@example.com',
    COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
    SUPERVISOR_TOKEN: 's',
    COMPUTER_TOKEN: 'c',
  };
  assert.equal(gateFullConfig(resolveUpstreamConfig(base)).ok, true);
  // Unsafe single-user.
  const single = gateFullConfig(resolveUpstreamConfig({ ...base, OPENBOT_SINGLE_USER: 'true' }));
  assert.equal(single.ok, false);
  assert.match(single.reason, /SINGLE_USER/);
  // Managed URL without opt-in.
  const managed = gateFullConfig(resolveUpstreamConfig({ ...base, INTELLIGENCE_API_URL: 'https://api.intelligence.copilotkit.ai' }));
  assert.equal(managed.ok, false);
  assert.match(managed.reason, /managed/i);
  // Missing key => NEEDS_INPUT via doctor.
  const { CPK_INTELLIGENCE_API_KEY: _drop, ...noKey } = base;
  const gated = gateFullConfig(resolveUpstreamConfig(noKey));
  assert.equal(gated.ok, false);
});

test('full doctor NEEDS_INPUT without credentials, FAILED on unsafe config', async () => {
  const needs = await checkUpstreamPlatform({ env: { ME_UPSTREAM_MODE: 'full' }, probe: false, repoRoot: process.cwd() });
  assert.equal(needs.state, 'NEEDS_INPUT');
  const bad = await checkUpstreamPlatform({
    env: {
      ME_UPSTREAM_MODE: 'full',
      DATABASE_URL: 'postgres://x',
      KEY_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ME_HOME_BRIDGE_SECRET: 'b'.repeat(40),
      INTELLIGENCE_API_URL: 'https://intel.example',
      INTELLIGENCE_GATEWAY_WS_URL: 'wss://intel.example',
      CPK_INTELLIGENCE_API_KEY: 'k',
      BETTER_AUTH_URL: 'http://localhost:3001',
      BETTER_AUTH_SECRET: 's'.repeat(32),
      INITIAL_ADMIN_EMAILS: 'a@example.com',
      OPENBOT_SINGLE_USER: 'true',
      COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
      SUPERVISOR_TOKEN: 's',
      COMPUTER_TOKEN: 'c',
    },
    probe: false,
    repoRoot: process.cwd(),
  });
  assert.equal(bad.state, 'FAILED');
});

test('no-probe never yields production READY', async () => {
  const report = await checkUpstreamPlatform({ env: fullEnv(), probe: false, repoRoot: process.cwd() });
  assert.equal(report.protocol, 'upstream-platform-v1');
  assert.equal(report.state, 'NEEDS_INPUT');
  assert.ok(report.checks.needs.some((r) => /probe disabled/.test(r)), 'names the probe gate');
});

test('full READY requires live stack: server, postgres TCP, authed entitlement, selected model', async (t) => {
  const pgPort = await loopbackTcp(t);
  const activeSdk = class {
    constructor() {}
    async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; }
  };
  const deployedOk = () => ({ ok: true, reason: 'stub deployed ok', report: { configured: true, head: 'stub', filesOk: 1, patchApplied: true, ok: true } });
  const report = await checkUpstreamPlatform({
    env: fullEnv({ DATABASE_URL: `postgres://openbot:x@127.0.0.1:${pgPort}/openbot`, OPENBOT_CHECKOUT: '/tmp/doctor-stub-checkout' }),
    fetchImpl: okFetch(), probe: true, sdkClient: activeSdk, deployedVerifier: deployedOk, repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'READY');
  assert.equal(report.checks.intelligence.entitlement, 'ready');
  assert.equal(report.checks.intelligence.licensed, true);
  assert.equal(report.checks.model.selectedServed, true);
  assert.match(report.checks.postgres.live, /answers TCP/);
  assert.equal(report.checks.nativeAuth.authenticated, true);
  assert.equal(report.checks.nativeAuth.perPersonRoster, true);
  assert.equal(report.checks.nativeAuth.perPerson, true);
  assert.equal(report.checks.nativeAuth.roleGate, 'user-denied');
  assert.equal(report.checks.nativeAuth.fleet.personKeys, 1);
  assert.equal(report.checks.sourcePin.deployed.patchApplied, true);
});

test('expired Intelligence licence is FAILED, not NEEDS_INPUT', async () => {
  const expiredSdk = class {
    async getRuntimeEntitlements() {
      return { status: 'error', error: { code: 'RUNTIME_ENTITLEMENTS_SELF_HOSTED_EXPIRED' } };
    }
  };
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: okFetch(), probe: true, sdkClient: expiredSdk, repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'FAILED');
  assert.ok(report.checks.failures.some((f) => /licence/i.test(f)));
});

test('rejected Intelligence key is FAILED', async () => {
  const badKeySdk = class {
    async getRuntimeEntitlements() { throw Object.assign(new Error('unauthorized'), { status: 401 }); }
  };
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: okFetch(), probe: true, sdkClient: badKeySdk, repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'FAILED');
});

test('absent Intelligence SDK is honest NEEDS_INPUT (completable, never hardcoded)', async () => {
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: okFetch(), probe: true, repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'NEEDS_INPUT');
  assert.ok(report.checks.needs.some((r) => /SDK unavailable|not installed/.test(r)));
});

test('selected local model must be served (tags list enforced)', async () => {
  const noModel = okFetch(async (url) => {
    if (String(url).endsWith('/api/tags')) {
      return J(200, { models: [{ name: 'other:1' }] });
    }
    throw new Error(`unexpected ${url}`);
  });
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: noModel, probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'NEEDS_INPUT');
  assert.ok(report.checks.needs.some((r) => /llama3\.1.*not served/.test(r)));
});

test('unreachable Postgres is NEEDS_INPUT, not silent READY', async () => {
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: okFetch(), probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'NEEDS_INPUT');
  assert.ok(report.checks.needs.some((r) => /Postgres unreachable/.test(r)));
});

test('openai key rejection is FAILED; missing native key is NEEDS_INPUT', async () => {
  const denied = okFetch(async (url) => {
    if (String(url).endsWith('/models')) return J(401, {});
    throw new Error(`unexpected ${url}`);
  });
  const bad = await checkUpstreamPlatform({
    env: fullEnv({ BOT_PROVIDER: 'openai', BOT_MODEL: 'gpt-5.5', OPENAI_API_KEY: 'bad', OPENAI_BASE_URL: '' }),
    fetchImpl: denied, probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.equal(bad.state, 'FAILED');
  const missing = await checkUpstreamPlatform({
    env: fullEnv({ BOT_PROVIDER: 'openai', BOT_MODEL: 'gpt-5.5', OPENAI_BASE_URL: '' }),
    fetchImpl: okFetch(), probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.equal(missing.state, 'NEEDS_INPUT');
  assert.ok(missing.checks.needs.some((r) => /OPENAI_API_KEY missing/.test(r)));
});

test('native provider:model prefix and unknown provider handling', async () => {
  const sdk = class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } };
  const prefixed = await checkUpstreamPlatform({
    env: fullEnv({ BOT_MODEL: 'anthropic:claude-haiku-4-5-20251001', ANTHROPIC_API_KEY: 'k' }),
    fetchImpl: okFetch(async (url) => {
      if (String(url).endsWith('/v1/models')) return J(200, { data: [{ id: 'claude-haiku-4-5-20251001' }] });
      throw new Error(`unexpected ${url}`);
    }),
    probe: true, sdkClient: sdk, repoRoot: process.cwd(),
  });
  assert.equal(prefixed.checks.model.provider, 'anthropic');
  assert.equal(prefixed.checks.model.selectedServed, true);
  const unknown = await checkUpstreamPlatform({
    env: fullEnv({ BOT_PROVIDER: 'ollama' }),
    fetchImpl: okFetch(), probe: true, sdkClient: sdk, repoRoot: process.cwd(),
  });
  assert.equal(unknown.state, 'FAILED');
  assert.ok(unknown.checks.failures.some((f) => /BOT_PROVIDER must be/.test(f)));
});

test('google native list is verified read-only with exact ids', async () => {
  const listed = okFetch(async (url) => {
    if (String(url).includes('/v1beta/models')) {
      return J(200, { models: [{ name: 'models/gemini-2.5-flash' }] });
    }
    throw new Error(`unexpected ${url}`);
  });
  const report = await checkUpstreamPlatform({
    env: fullEnv({ BOT_PROVIDER: 'google', BOT_MODEL: 'gemini-2.5-flash', GOOGLE_API_KEY: 'k' }),
    fetchImpl: listed, probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.equal(report.checks.model.selectedServed, true);
});

test('supervisor docker:false is FAILED (computers cannot run)', async () => {
  const noDocker = okFetch(async (url) => {
    if (String(url).endsWith('/health')) return J(200, { status: 'ok', docker: false });
    throw new Error(`unexpected ${url}`);
  });
  const report = await checkUpstreamPlatform({
    env: { ME_UPSTREAM_MODE: 'core', COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500', SUPERVISOR_TOKEN: 's', COMPUTER_TOKEN: 'c' },
    fetchImpl: noDocker, repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'FAILED');
  assert.ok(report.checks.failures.some((f) => /docker:false/.test(f)));
});

test('health-proxy-only stack is NOT READY (capabilities + native auth required)', async () => {
  const proxyOnly = okFetch(async (url) => {
    if (String(url).endsWith('/health')) return J(200, { status: 'ok', docker: true });
    if (String(url).endsWith('/api/capabilities')) return J(404, {});
    if (String(url).endsWith('/api/agents')) return J(401, { error: 'x' });
    throw new Error(`unexpected ${url}`);
  });
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: proxyOnly, probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.notEqual(report.state, 'READY');
  assert.ok(report.checks.failures.some((f) => /capabilities/.test(f)));
});

test('vendor lock resolves from the module root, not the caller cwd', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const elsewhere = await mkdtemp(join(tmpdir(), 'me-doctor-cwd-'));
  t.after(async () => { await rm(elsewhere, { recursive: true, force: true }); });
  const prev = process.cwd();
  process.chdir(elsewhere);
  try {
    const report = await checkUpstreamPlatform({ env: { ME_UPSTREAM_MODE: 'core' }, probe: false });
    assert.ok(!report.checks.failures?.some((f) => /missing or unreadable/.test(f)), 'lock must resolve without caller cwd');
    assert.equal(report.protocol, 'upstream-platform-v1');
  } finally {
    process.chdir(prev);
  }
});

test('verifyDeployedCheckout: git footprint + hashes, not markers alone', async (t) => {
  const { verifyDeployedCheckout } = await import('../src/upstream-doctor.mjs');
  const { mkdtemp, rm, mkdir, writeFile, chmod } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'me-deployed-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const { execFileSync } = await import('node:child_process');
  const lockFiles = { LICENSE: 'mit-text', 'server/src/app.ts': 'app-src', 'server/src/index.ts': 'index-src', 'server/src/config.ts': 'config-src' };
  const lock = { repository: 'CopilotKit/OpenBot', revision: 'HEAD', files: {} };
  const { createHash } = await import('node:crypto');
  for (const [name, content] of Object.entries(lockFiles)) {
    lock.files[name] = createHash('sha256').update(content).digest('hex');
  }
  const seed = async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'server/src'), { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    for (const [name, content] of Object.entries(lockFiles)) {
      await writeFile(join(dir, name), content);
    }
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    lock.revision = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // Approved footprint: uncommitted patch changes only.
    await writeFile(join(dir, 'server/src/index.ts'), `${lockFiles['server/src/index.ts']}\nwrapAuthWithHomeBridge(homeAuth`);
    await writeFile(join(dir, 'server/src/home-bridge.ts'), 'wrapAuthWithHomeBridge ME_HOME_BRIDGE_SECRET timingSafeEqual');
  };
  assert.deepEqual(verifyDeployedCheckout(join(dir, 'nope'), lock).missing, true);
  execFileSync('git', ['init', '-q', join(dir, 'empty')]);
  await mkdir(join(dir, 'empty'), { recursive: true });
  assert.equal(verifyDeployedCheckout(join(dir, 'empty'), lock).ok, false);
  await seed();
  const ok = verifyDeployedCheckout(dir, lock);
  assert.equal(ok.ok, true);
  assert.equal(ok.report.patchApplied, true);
  assert.equal(ok.report.filesOk, 2, 'only non-seam lock files are hash-checked');
  // Tampered non-seam tracked file => drift, even though markers are intact.
  await writeFile(join(dir, 'server/src/app.ts'), 'tampered');
  const drift = verifyDeployedCheckout(dir, lock);
  assert.equal(drift.ok, false);
  assert.match(drift.reason, /drift/);
  // Unapproved new source file => drift.
  await writeFile(join(dir, 'server/src/app.ts'), lockFiles['server/src/app.ts']);
  await writeFile(join(dir, 'server/src/evil.ts'), 'nope');
  const added = verifyDeployedCheckout(dir, lock);
  assert.equal(added.ok, false);
  assert.match(added.reason, /unapproved new source file/);
  await rm(join(dir, 'server/src/evil.ts'));
  // Missing markers corroborate refusal.
  await writeFile(join(dir, 'server/src/home-bridge.ts'), 'no markers');
  const unpatched = verifyDeployedCheckout(dir, lock);
  assert.equal(unpatched.ok, false);
  // Trusted post-hash manifest enforced exactly when present.
  await writeFile(join(dir, 'server/src/home-bridge.ts'), 'wrapAuthWithHomeBridge ME_HOME_BRIDGE_SECRET timingSafeEqual');
  const indexHash = createHash('sha256').update(await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'server/src/index.ts')))).digest('hex');
  const manifestOk = verifyDeployedCheckout(dir, lock, { manifest: { files: { 'server/src/index.ts': indexHash } } });
  assert.equal(manifestOk.ok, true);
  assert.equal(manifestOk.report.manifestOk, 1);
  await writeFile(join(dir, 'server/src/index.ts'), `${lockFiles['server/src/index.ts']}\nwrapAuthWithHomeBridge(homeAuth\n// extra`);
  const manifestBad = verifyDeployedCheckout(dir, lock, { manifest: { files: { 'server/src/index.ts': indexHash } } });
  assert.equal(manifestBad.ok, false);
  assert.match(manifestBad.reason, /trusted patch manifest/);
});

test('privacy gates: upstream push text, telemetry on, world-writable storage are FAILED', async (t) => {
  const deployedOk = () => ({ ok: true, reason: 'stub', report: { configured: true, head: 'stub', filesOk: 1, patchApplied: true, ok: true } });
  const sdk = class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } };
  const push = await checkUpstreamPlatform({
    env: fullEnv({ EXPO_PROJECT_ID: '12345678-1234-1234-1234-123456789012' }),
    fetchImpl: okFetch(), probe: true, sdkClient: sdk, deployedVerifier: deployedOk, repoRoot: process.cwd(),
  });
  assert.equal(push.state, 'FAILED');
  assert.ok(push.checks.failures.some((f) => /EXPO_PROJECT_ID/.test(f)));
  const tele = await checkUpstreamPlatform({
    env: fullEnv({ OPENBOT_PRODUCT_TELEMETRY: '1' }),
    fetchImpl: okFetch(), probe: true, sdkClient: sdk, deployedVerifier: deployedOk, repoRoot: process.cwd(),
  });
  assert.equal(tele.state, 'FAILED');
  const { mkdtemp, rm, chmod } = await import('node:fs/promises');
  const wdir = await mkdtemp(join(tmpdir(), 'me-worldwrite-'));
  t.after(async () => { await rm(wdir, { recursive: true, force: true }); });
  await chmod(wdir, 0o777);
  const perms = await checkUpstreamPlatform({
    env: fullEnv({ OPENBOT_CHECKOUT: wdir }),
    fetchImpl: okFetch(), probe: true, sdkClient: sdk, deployedVerifier: deployedOk, repoRoot: process.cwd(),
  });
  assert.equal(perms.state, 'FAILED');
  assert.ok(perms.checks.failures.some((f) => /world-writable/.test(f)));
});

test('anthropic models are verified read-only with exact ids; redirect refused', async () => {
  const sdk = class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } };
  const listed = okFetch(async (url) => {
    if (String(url).endsWith('/v1/models')) {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => Buffer.from(JSON.stringify({ data: [{ id: 'claude-haiku-4-5-20251001' }] })),
      };
    }
    throw new Error(`unexpected ${url}`);
  });
  const good = await checkUpstreamPlatform({
    env: fullEnv({ BOT_PROVIDER: 'anthropic', BOT_MODEL: 'claude-haiku-4-5-20251001', ANTHROPIC_API_KEY: 'k' }),
    fetchImpl: listed, probe: true, sdkClient: sdk, repoRoot: process.cwd(),
  });
  assert.equal(good.checks.model.selectedServed, true);
  const moved = okFetch(async (url) => {
    if (String(url).endsWith('/v1/models')) return { ok: false, status: 301, arrayBuffer: async () => Buffer.from('') };
    throw new Error(`unexpected ${url}`);
  });
  const redir = await checkUpstreamPlatform({
    env: fullEnv({ BOT_PROVIDER: 'anthropic', BOT_MODEL: 'x', ANTHROPIC_API_KEY: 'k' }),
    fetchImpl: moved, probe: true, sdkClient: sdk, repoRoot: process.cwd(),
  });
  assert.equal(redir.checks.model.selectedServed, undefined);
  assert.ok(redir.checks.needs.some((r) => /redirect refused|unreachable/.test(r)));
});

test('shared fleet provider fails the stack (per-person isolation unenforced)', async () => {
  // A provider that answers the deployment-wide fleet to a USER assertion
  // shares computers across people: every other check may pass, but the
  // stack must NOT be READY.
  const shared = okFetch(async (url) => {
    if (String(url).endsWith('/api/computers/fleet')) {
      return J(200, { isolation: 'shared', computers: [{ computer: 'person:u_alice', kind: 'person' }] });
    }
    throw new Error(`unexpected ${url}`);
  });
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: shared, probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'FAILED');
  assert.ok(report.checks.failures.some((f) => /shared provider/.test(f)));
});

test('native auth probe refusal fails the stack (patch missing on upstream)', async () => {
  const refused = okFetch(async (url) => {
    if (String(url).endsWith('/api/agents')) return { ok: false, status: 401, arrayBuffer: async () => Buffer.from('{}') };
    throw new Error(`unexpected ${url}`);
  });
  const report = await checkUpstreamPlatform({
    env: fullEnv(), fetchImpl: refused, probe: true,
    sdkClient: class { async getRuntimeEntitlements() { return { status: 'ready', entitlement: { active: true } }; } },
    repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'FAILED');
  assert.ok(report.checks.failures.some((f) => /native auth probe refused/.test(f)));
});

test('Intelligence SDK version mismatch is NEEDS_INPUT, never silent pass', async (t) => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'me-sdks-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const pkg = join(root, 'node_modules/@copilotkit/runtime');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: '@copilotkit/runtime', version: '9.9.9',
    exports: { './v2': './v2.js', './package.json': './package.json' },
  }));
  await writeFile(join(pkg, 'v2.js'), 'exports.CopilotKitIntelligence = class { constructor() {} };');
  const report = await checkUpstreamPlatform({
    env: fullEnv({ INTELLIGENCE_SDK_ROOT: root }),
    fetchImpl: okFetch(), probe: true, repoRoot: process.cwd(),
  });
  assert.equal(report.state, 'NEEDS_INPUT');
  assert.ok(report.checks.needs.some((r) => /version mismatch.*9\.9\.9.*1\.83\.0/.test(r)));
});
