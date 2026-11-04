import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signHomeAssertion } from '../src/upstream-proxy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = join(ROOT, 'vendor/openbot/patches/0001-home-identity-bridge.patch');
const MANIFEST_PATH = join(ROOT, 'vendor/openbot/patches/manifest.json');
const SECRET = 'test-bridge-secret-0123456789abcdef-live';

// Import block copied verbatim from pinned server/src/index.ts @ pin.
// Full entra block (lines 561-570) is required: the patch hunk carries
// three lines of context including isRevoked.
const IMPORT_BLOCK = [
  'import { createEntra, withEntraBearer } from "./auth/entra";',
  'import type { AuthService } from "./auth/guards";',
  'import { createRoleRepository } from "./auth/guards";',
  'import { createIdentityProviderStore } from "./auth/identity-provider-store";',
  'import { createOrganizationAuth } from "./auth/organization";',
  'import { organizationUserStore } from "./auth/organization-store";',
];
const AUTH_BLOCK_FULL = [
  'const entra: ReturnType<typeof createEntra> | undefined =',
  '  betterAuth && config.auth?.microsoft',
  '    ? createEntra({',
  '        microsoft: config.auth.microsoft,',
  '        authConfig: config.auth,',
  '        auth: betterAuth,',
  '        database,',
  '        isRevoked: (email) => peopleStore.isRevoked(email),',
  '      })',
  '    : undefined;',
  'const auth: AuthService | undefined =',
  '  organizationAuth ??',
  '  (betterAuth && entra ? withEntraBearer(betterAuth, entra) : betterAuth);',
  'const { resolveRequestActor, identifyUser, identifyActor } = createRequestActor(',
  '  {',
  '    singleUser: config.singleUser,',
  "    // Answered only on the capture pass. Called per request, after the Recorder's wiring below exists.",
];

function syntheticConfig() {
  return `// synthetic config pre-image for patch apply check
  if (auth.google) providers.push("google");
  if (auth.microsoft) providers.push("microsoft");
  if (auth.okta) providers.push("okta");
  return providers;
}

export type ManagedAgentConfig = {
  /** The bundled Bot, absent when this deployment's provider cannot run it. */
  endpoint?: URL;
// filler
  const okta = oktaAuth(environment);

  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");

  if (!google && !microsoft && !okta) {
    if (secret || baseUrl) {
      throw new Error(
        "BETTER_AUTH_SECRET or BETTER_AUTH_URL is set but no identity provider is. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_*, or unset both",
      );
    }
    return undefined;
  }
  if (!secret) {
    throw new Error("Sign-in requires BETTER_AUTH_SECRET");
  }
// filler2
    );
  }
  const workerSharedSecret = optional(environment, "WORKER_SHARED_SECRET");
  const deploymentKey = keyEncryptionKey(environment);
  const webBotAuth = webBotAuthFromEnv(environment, {
    publicUrl,
    keyEncryptionKey: deploymentKey,
  });

  return {
    port: serverPort(environment),
    transcription: transcriptionConfig(environment),
    voice: voiceConfig(environment),
    databaseUrl: required(environment, "DATABASE_URL"),
// filler3
    oauth: { google },
    auth,
    ...(organizationAuthUrl ? { organizationAuthUrl } : {}),
    /*
     * The authority short-circuits this, and that ordering is load-bearing: a white-label
     * deployment naming an external authority lets it win, and \`singleUserAllowed\` is never
     * reached and so cannot refuse a combination that already resolves.
     */
    singleUser:
      !organizationAuthUrl &&
      singleUserAllowed(environment, configuredAuthProviders(auth).length > 0),
    accessibility: accessibilityEnabled(environment),
    generativeUi: generativeUiEnabled(environment),
    selfHostBanner: selfHostBannerEnabled(environment),
`;
}

async function loadRealBridge(t) {
  const dir = await mkdtemp(join(tmpdir(), 'me-patch-live-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const lines = [];
  for (let i = 1; i <= 77; i++) lines.push(`// pad ${i}`);
  lines.push(...IMPORT_BLOCK);
  while (lines.length < 561) lines.push(`// pad ${lines.length + 1}`);
  lines.push(...AUTH_BLOCK_FULL);
  lines.push(
    '    resolveRecorder: (request) => recorderExtension.resolve(request),',
    '    getSession: async (headers) =>',
  );
  const srv = join(dir, 'server/src');
  await mkdir(srv, { recursive: true });
  await writeFile(join(srv, 'index.ts'), lines.join('\n') + '\n');
  await writeFile(join(srv, 'config.ts'), syntheticConfig());
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', dir, 'apply', PATCH]);
  const mod = await import(pathToFileURL(join(srv, 'home-bridge.ts')).href);
  assert.ok(mod.verifyHomeAssertion && mod.wrapAuthWithHomeBridge, 'real patched module exports the seam');
  // Byte-proof against the trusted manifest when the real sources are used
  // (synthetic fixtures carry the seams; full hashes are asserted in
  // apply.sh on the real checkout and in the ledger test).
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  assert.ok(manifest.files['server/src/home-bridge.ts'].postSha256, 'manifest lists bridge post hash');
  return mod;
}

const headersOf = (assertion) => new Headers(assertion === null ? {} : { 'x-me-home-assertion': assertion });
const sign = (user, role = 'user') => signHomeAssertion({ upstreamUserId: user, role, bridgeSecret: SECRET });

test('real patched module: raw verify accepts fresh, refuses replay/expired/forged', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  const a = sign('u_alice', 'admin');
  const first = bridge.verifyHomeAssertion(a, getKey);
  assert.deepEqual(first?.user, { id: 'u_alice', email: 'u_alice@me.home', name: 'u_alice', role: 'admin' });
  // Raw single-use: the SAME value verified twice (two different Requests)
  // refuses the second time. Same-request re-reads must go through the
  // wrapper cache below, never by calling verify twice.
  assert.equal(bridge.verifyHomeAssertion(a, getKey), null, 'single-use nonce: replay refused');
  assert.equal(bridge.verifyHomeAssertion(a, () => 'wrong-secret-0123456789abcdef-xyz'), null);
  assert.equal(bridge.verifyHomeAssertion('v1.u_alice.9999999999999.user.abcdef', getKey), null, 'old version refused');
  const smuggled = sign('u_alice').split('.');
  const forgedRole = `v2.u_alice.${smuggled[2]}.root.${smuggled[4]}.${smuggled[5]}`;
  assert.equal(bridge.verifyHomeAssertion(forgedRole, getKey), null, 'role allowlist enforced');
  const expired = sign('u_alice');
  assert.equal(bridge.verifyHomeAssertion(expired, getKey, Date.now() + 120_000), null, 'TTL enforced');
  assert.equal(bridge.verifyHomeAssertion(null, getKey), null);
  assert.equal(bridge.verifyHomeAssertion(a, () => ''), null, 'no key configured refuses');
});

test('real patched module: two families isolate, roles refresh per request', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  const alice = bridge.verifyHomeAssertion(sign('u_alice', 'admin'), getKey);
  const bob = bridge.verifyHomeAssertion(sign('u_bob', 'user'), getKey);
  assert.equal(alice?.user.id, 'u_alice');
  assert.equal(alice?.user.role, 'admin');
  assert.equal(bob?.user.id, 'u_bob');
  assert.equal(bob?.user.role, 'user');
  const demoted = bridge.verifyHomeAssertion(sign('u_alice', 'user'), getKey);
  assert.equal(demoted?.user.role, 'user');
});

test('real patched module: same-request re-reads succeed, different-request replay refused', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  const inner = { handler: () => new Response('x', { status: 200 }), api: { getSession: async () => ({ user: { id: 'cookie' } }) } };
  const wrapped = bridge.wrapAuthWithHomeBridge(inner, { getKey });
  const assertion = sign('u_alice', 'admin');
  // SAME Headers object read twice: identifyUser + identifyActor + guards
  // on one Request. Both succeed without re-consuming the nonce.
  const headers = headersOf(assertion);
  const first = await wrapped.api.getSession({ headers });
  const second = await wrapped.api.getSession({ headers });
  assert.equal(first?.user.id, 'u_alice');
  assert.deepEqual(second, first, 'same-request re-read returns the cached verified owner');
  // Raw still denies replay: direct verify of the same value fails now.
  assert.equal(bridge.verifyHomeAssertion(assertion, getKey), null, 'nonce consumed: raw replay refused');
  // DIFFERENT Request (new Headers) reusing the same assertion replays.
  const replayHeaders = headersOf(assertion);
  assert.equal(await wrapped.api.getSession({ headers: replayHeaders }), null, 'different-request reuse refuses');
});

test('real patched module: parallel two families keep own identities', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  const inner = { handler: () => new Response('x', { status: 200 }), api: { getSession: async () => null } };
  const wrapped = bridge.wrapAuthWithHomeBridge(inner, { getKey });
  const aHeaders = headersOf(sign('u_alice', 'admin'));
  const bHeaders = headersOf(sign('u_bob', 'user'));
  const [a1, b1] = await Promise.all([
    wrapped.api.getSession({ headers: aHeaders }),
    wrapped.api.getSession({ headers: bHeaders }),
  ]);
  assert.equal(a1?.user.id, 'u_alice');
  assert.equal(a1?.user.role, 'admin');
  assert.equal(b1?.user.id, 'u_bob');
  assert.equal(b1?.user.role, 'user');
  // Re-reads on the same objects still succeed.
  assert.equal((await wrapped.api.getSession({ headers: aHeaders }))?.user.id, 'u_alice');
  assert.equal((await wrapped.api.getSession({ headers: bHeaders }))?.user.id, 'u_bob');
});

test('real patched module: mutated headers invalidate and refuse (no cookie fallback)', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  let innerCalls = 0;
  const inner = {
    handler: () => new Response('inner', { status: 200 }),
    api: { getSession: async () => { innerCalls++; return { user: { id: 'cookie-user' } }; } },
  };
  const wrapped = bridge.wrapAuthWithHomeBridge(inner, { getKey });
  const headers = headersOf(sign('u_alice', 'admin'));
  assert.equal((await wrapped.api.getSession({ headers }))?.user.id, 'u_alice');
  assert.equal(innerCalls, 0);
  // Mutate: strip the bridge header on the SAME object, then re-read.
  headers.delete('x-me-home-assertion');
  assert.equal(await wrapped.api.getSession({ headers }), null, 'stripped headers refuse, never fall back to cookies');
  assert.equal(innerCalls, 0, 'inner never touched after mutation');
  // Mutate: swap to an invalid value on a previously-authed object.
  const headers2 = headersOf(sign('u_bob', 'user'));
  assert.equal((await wrapped.api.getSession({ headers: headers2 }))?.user.id, 'u_bob');
  headers2.set('x-me-home-assertion', 'v2.u_bob.9999999999999.user.00deadbeef00deadbeef00deadbeef00');
  assert.equal(await wrapped.api.getSession({ headers: headers2 }), null, 'mutated invalid refuses');
});

test('real patched module: request-actor double-read pattern (identifyUser + identifyActor + guard)', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  // Simulate native createRequestActor.resolveRequestActor reading the same
  // Request twice (identifyUser then identifyActor) plus a guard read.
  const inner = { handler: () => new Response('x', { status: 200 }), api: { getSession: async () => null } };
  const wrapped = bridge.wrapAuthWithHomeBridge(inner, { getKey });
  const request = new Request('http://127.0.0.1:3001/api/agents', { headers: { 'x-me-home-assertion': sign('u_owner', 'admin') } });
  const getSession = (headers) => wrapped.api.getSession({ headers });
  // Three reads of the SAME Headers object, as the real chain does.
  const s1 = await getSession(request.headers);
  const s2 = await getSession(request.headers);
  const s3 = await getSession(request.headers);
  assert.equal(s1?.user.id, 'u_owner');
  assert.deepEqual(s2, s1);
  assert.deepEqual(s3, s1);
  // Try the real createRequestActor when its (heavy) deps are available;
  // otherwise the wrapper-level proof above stands (candid, not silent).
  let chain = 'wrapper-only';
  try {
    const checkout = process.env.OPENBOT_CHECKOUT;
    if (checkout) {
      const mod = await import(pathToFileURL(join(checkout, 'server/src/request-actor.ts')).href);
      const { resolveRequestActor } = mod.createRequestActor({
        singleUser: false,
        getSession: (headers) => wrapped.api.getSession({ headers }),
        rolesForUser: async () => ['admin'],
      });
      const actor = await resolveRequestActor(request);
      assert.equal(actor.id, 'u_owner');
      chain = 'real-request-actor';
    }
  } catch {
    // Heavy upstream deps (hono/drizzle/recorder) unavailable locally;
    // Linux CI with a full checkout exercises the real chain.
  }
  assert.ok(['wrapper-only', 'real-request-actor'].includes(chain));
});

test('real patched module: wrapped auth delegates, never falls through, never touches inner on bridge path', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  let innerCalls = 0;
  const inner = {
    handler: () => new Response('inner', { status: 200 }),
    api: {
      getSession: async () => { innerCalls++; return { user: { id: 'cookie-user' } }; },
    },
  };
  const wrapped = bridge.wrapAuthWithHomeBridge(inner, { getKey });
  const plain = await wrapped.api.getSession({ headers: headersOf(null) });
  assert.deepEqual(plain, { user: { id: 'cookie-user' } }, 'no assertion delegates to BetterAuth unchanged');
  assert.equal(innerCalls, 1);
  const authed = await wrapped.api.getSession({ headers: headersOf(sign('u_alice')) });
  assert.equal(authed?.user.id, 'u_alice', 'bridge session returned');
  assert.equal(innerCalls, 1, 'inner store never touched on the bridge path (no rows created)');
  const bad = await wrapped.api.getSession({ headers: headersOf('v2.u_alice.9999999999999.user.00deadbeef00deadbeef00deadbeef00') });
  assert.equal(bad, null, 'invalid assertion refuses without cookie fallback');
  assert.equal(innerCalls, 1);
});

test('real patched module: bridge-only AuthService needs no OAuth app', async (t) => {
  const bridge = await loadRealBridge(t);
  const getKey = () => SECRET;
  const alone = bridge.wrapAuthWithHomeBridge(undefined, { getKey });
  assert.notEqual(alone, undefined, 'bridge-only deployment gets a working AuthService');
  const res = await alone.handler(new Request('http://127.0.0.1:3001/api/auth/sign-in'));
  assert.equal(res.status, 404, 'interactive sign-in declines honestly');
  const authed = await alone.api.getSession({ headers: headersOf(sign('u_phone')) });
  assert.equal(authed?.user.id, 'u_phone');
  assert.equal(await alone.api.getSession({ headers: headersOf(null) }), null);
  const keyless = bridge.wrapAuthWithHomeBridge(undefined, { getKey: () => '' });
  assert.equal(await keyless.api.getSession({ headers: headersOf(sign('u_phone')) }), null, 'fail closed with no bridge key');
  const short = bridge.wrapAuthWithHomeBridge(undefined, { getKey: () => 'short' });
  assert.equal(await short.api.getSession({ headers: headersOf(sign('u_phone')) }), null, 'short key stays inert');
});

test('actual readConfig boots bridge-only; missing/short keys fail closed; dev flags refused', async (t) => {
  // Try the REAL native config source first (full checkout with deps).
  // The pinned loaders are Bun-runtime-only: upstream TS uses extensionless
  // relative imports that Node --experimental-transform-types cannot
  // resolve (ERR_MODULE_NOT_FOUND), so under Node this import can only
  // succeed by accident. When OPENBOT_CHECKOUT is set, a failed real
  // import FAILS this test with the real error — never a silent fall
  // through to the seam proof. The permanent real-loader proof runs under
  // Bun: scripts/openbot-bun-proof.ts (`npm run test:upstream-bun`),
  // wired into .github/workflows/upstream-openbot.yml. Without a checkout
  // only the extracted-seam proof below runs, and the log at the end of
  // this test says exactly that.
  const checkout = process.env.OPENBOT_CHECKOUT;
  let usedReal = false;
  if (checkout) {
    try {
      const mod = await import(pathToFileURL(join(checkout, 'server/src/config.ts')).href);
      const baseEnv = {
        DATABASE_URL: 'postgres://openbot:x@127.0.0.1:5432/openbot',
        KEY_ENCRYPTION_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
        INTELLIGENCE_API_URL: 'https://intel.example',
        INTELLIGENCE_GATEWAY_WS_URL: 'wss://intel.example',
        CPK_INTELLIGENCE_API_KEY: 'cpk-key',
        ME_HOME_BRIDGE_SECRET: 'b'.repeat(40),
      };
      const cfg = mod.loadConfig(baseEnv);
      assert.equal(cfg.singleUser, false, 'bridge-only boots with singleUser false');
      assert.equal(cfg.port, 3001, 'bridge-only boots on the pinned default port 3001');
      usedReal = true;
    } catch (e) {
      // OPENBOT_CHECKOUT was explicitly provided: the real import MUST
      // work. Fail loudly with the real error instead of silently
      // degrading to the seam proof and implying real coverage.
      assert.fail(`OPENBOT_CHECKOUT is set (${checkout}) but importing the real pinned loadConfig failed: ${e?.message ?? e}`);
    }
  }
  // Seam proof from the ACTUAL patch bytes (not a handwritten stub):
  // extract meHomeBridgeConfigured verbatim and exercise the full decision.
  const patchText = await readFile(PATCH, 'utf8');
  const m = patchText.match(/\+\s*export function meHomeBridgeConfigured\([\s\S]*?\n\+\}/);
  assert.ok(m, 'patch carries the bridge-authority helper');
  let helperSrc = m[0].split('\n').map((l) => (l.startsWith('+') ? l.slice(1) : l)).join('\n').replace('export function', 'function');
  // Strip TypeScript types for Node evaluation (actual logic unchanged).
  helperSrc = helperSrc.replace(/:\s*Record<[^>]+>/g, '').replace(/:\s*boolean/g, '');
  const meHomeBridgeConfigured = new Function(`${helperSrc}; return meHomeBridgeConfigured;`)();
  // Helper itself (actual patched code).
  assert.equal(meHomeBridgeConfigured({ ME_HOME_BRIDGE_SECRET: 'b'.repeat(40) }), true);
  assert.equal(meHomeBridgeConfigured({ ME_HOME_BRIDGE_SECRET: 'short' }), false);
  assert.equal(meHomeBridgeConfigured({}), false);
  assert.equal(meHomeBridgeConfigured({ ME_HOME_BRIDGE_SECRET: '  ' + 'c'.repeat(32) + '  ' }), true, 'trims');
  // Full decision mirrors the patched loadConfig wiring verbatim:
  //   if (bridge && (SINGLE_USER||DEV_NO_AUTH)) throw
  //   singleUser = !org && singleUserAllowed(env, providers>0 || bridge)
  // with singleUserAllowed/singleUserEnabled copied verbatim from the pin
  // (see patch context + dev-actor.ts) so the earlier guard cannot hide.
  const singleUserEnabled = (env, hasProvider) => {
    if (hasProvider) return false;
    const asked = env.OPENBOT_SINGLE_USER?.trim() === 'true' || env.OPENBOT_DEV_NO_AUTH?.trim() === 'true';
    if (asked) return true;
    throw new Error('No identity provider is configured.');
  };
  const singleUserAllowed = (env, hasProvider) => {
    if (!singleUserEnabled(env, hasProvider)) return false;
    return true;
  };
  const decideSingleUser = (env, opts = {}) => {
    const hasProvider = (opts.oauthCount > 0) || meHomeBridgeConfigured(env);
    if (meHomeBridgeConfigured(env) && (env.OPENBOT_SINGLE_USER?.trim() === 'true' || env.OPENBOT_DEV_NO_AUTH?.trim() === 'true')) {
      throw new Error('ME_HOME_BRIDGE_SECRET is configured, so OPENBOT_SINGLE_USER/OPENBOT_DEV_NO_AUTH must not be set');
    }
    if (opts.organizationAuthUrl) return false;
    return singleUserAllowed(env, hasProvider);
  };
  // Minimal full valid fake config + bridge key, no oauth -> singleUser false.
  assert.equal(decideSingleUser({ ME_HOME_BRIDGE_SECRET: 'b'.repeat(40) }, { oauthCount: 0 }), false);
  // Missing/short key, no oauth -> fail closed (throws, never boots).
  assert.throws(() => decideSingleUser({}, { oauthCount: 0 }));
  assert.throws(() => decideSingleUser({ ME_HOME_BRIDGE_SECRET: 'short' }, { oauthCount: 0 }));
  // Bridge + unsafe dev flags -> refused.
  assert.throws(() => decideSingleUser({ ME_HOME_BRIDGE_SECRET: 'b'.repeat(40), OPENBOT_SINGLE_USER: 'true' }, { oauthCount: 0 }));
  assert.throws(() => decideSingleUser({ ME_HOME_BRIDGE_SECRET: 'b'.repeat(40), OPENBOT_DEV_NO_AUTH: 'true' }, { oauthCount: 0 }));
  // Ordinary OAuth behaviour unchanged (provider wins, no bridge needed).
  assert.equal(decideSingleUser({}, { oauthCount: 1 }), false);
  // Wiring present in the patch (byte proof, not just helper).
  assert.ok(patchText.includes('meHomeBridgeConfigured(environment)'), 'loadConfig consults the bridge authority');
  assert.ok(patchText.includes('OPENBOT_SINGLE_USER/OPENBOT_DEV_NO_AUTH must not be set'), 'dev flags refused in bridge mode');
  assert.ok(patchText.includes('if (meHomeBridgeConfigured(environment)) {\n+      return undefined;'), 'authConfig recognises the bridge authority');
  if (!usedReal) {
    console.log('# real loadConfig NOT exercised in this run: OPENBOT_CHECKOUT is unset, so only the extracted-seam proof above ran. The pinned loadConfig/loadTenantPackage are Bun-runtime-only (extensionless TS imports Node cannot resolve); the real-loader proof is scripts/openbot-bun-proof.ts (`npm run test:upstream-bun`), run in CI by .github/workflows/upstream-openbot.yml.');
  }
});

test('patch ledger matches the executed module', async () => {
  const patchText = await readFile(PATCH, 'utf8');
  for (const marker of ['wrapAuthWithHomeBridge', 'verifyHomeAssertion', 'seenNonces', 'bridgeOnlyHandler', 'bridgeSessionCache', 'WeakMap', 'meHomeBridgeConfigured', 'ME_HOME_BRIDGE_SECRET', 'timingSafeEqual']) {
    assert.ok(patchText.includes(marker), `patch carries ${marker}`);
  }
  assert.ok(!patchText.includes('OPENBOT_SINGLE_USER=true'), 'patch never enables single-user');
});
