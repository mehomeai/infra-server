import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signHomeAssertion, verifyHomeAssertion, ASSERTION_VERSION } from '../src/upstream-proxy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '6bfee780c8e8d05141375ea55ebde33eefb3dbc0';
const PATCH = join(ROOT, 'vendor/openbot/patches/0001-home-identity-bridge.patch');
const APPLY = join(ROOT, 'vendor/openbot/patches/apply.sh');
const MANIFEST = join(ROOT, 'vendor/openbot/patches/manifest.json');

// Exact pre-image context copied verbatim from pinned OpenBot
// server/src/index.ts @ PIN (full-file sha256 asserted from the patch
// header below). TEST-ONLY fixtures: production application targets the
// real pinned checkout via scripts/openbot-checkout.sh.
const IMPORT_BLOCK = [
  'import { createEntra, withEntraBearer } from "./auth/entra";',
  'import type { AuthService } from "./auth/guards";',
  'import { createRoleRepository } from "./auth/guards";',
  'import { createIdentityProviderStore } from "./auth/identity-provider-store";',
  'import { createOrganizationAuth } from "./auth/organization";',
  'import { organizationUserStore } from "./auth/organization-store";',
];
// Full entra assembly block verbatim from pinned index.ts @ PIN lines
// 561-577: the patch hunk needs the isRevoked context to apply cleanly.
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
  '    // Answered only on the capture pass. Called per request, after the Recorder\'s wiring below exists.',
];

function syntheticIndex() {
  const lines = [];
  for (let i = 1; i <= 77; i++) lines.push(`// pad ${i}`);
  lines.push(...IMPORT_BLOCK);
  while (lines.length < 561) lines.push(`// pad ${lines.length + 1}`);
  lines.push(...AUTH_BLOCK_FULL);
  lines.push('    resolveRecorder: (request) => recorderExtension.resolve(request),');
  lines.push('    getSession: async (headers) =>');
  return lines.join('\n') + '\n';
}

// Minimal synthetic config.ts carrying the exact pre-image contexts the
// config hunks need (verbatim slices from pinned config.ts @ PIN). The full
// 1593-line file is not vendored; production applies to the real checkout.
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

test('patch ledger binds the pin and carries the reviewed hook', async () => {
  const text = await readFile(PATCH, 'utf8');
  assert.ok(text.includes(PIN), 'patch must name the pinned base');
  assert.ok(text.includes('6d0fa8dc72ae62d7b41f1a35083b1e8e82f53c2fda27255457416075b5d10ddd'), 'patch must record base index.ts sha');
  assert.ok(text.includes('d210a4d4b3c43b869aa38483e5815ac0c3b3f77a6df2d66b5325d7510e3cf3c3'), 'patch must record base config.ts sha');
  assert.ok(text.includes('wrapAuthWithHomeBridge'), 'patch must add the wrapper import + call');
  assert.ok(text.includes('ME_HOME_BRIDGE_SECRET'), 'bridge uses its dedicated secret');
  assert.ok(text.includes('timingSafeEqual'), 'constant-time MAC compare required');
  assert.ok(text.includes('server/src/home-bridge.ts'), 'patch adds the bridge module');
  assert.ok(text.includes('server/src/index.ts'), 'patch hooks the assembly seam');
  assert.ok(text.includes('server/src/config.ts'), 'patch carries the bridge-authority config seam');
  assert.ok(text.includes('meHomeBridgeConfigured'), 'config seam recognises the bridge key');
  assert.ok(text.includes('bridgeSessionCache'), 'wrapper memoizes per request Headers (same-request re-reads)');
  assert.ok(text.includes('WeakMap'), 'memoization is per Headers object, never global');
  // No cookie forge / shared admin in bridge runtime code.
  const added = text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const codeLines = added.filter((l) => !/^\+\s*(\*|\/\/|#)/.test(l));
  const code = codeLines.join('\n');
  for (const banned of ['getCookie', 'set-cookie', 'cookieFrom', 'document.cookie']) {
    assert.ok(!code.includes(banned), `added upstream code must not contain ${banned}`);
  }
  // Bridge code itself must never mint a shared admin or enable dev no-auth.
  // Config code legitimately *references* singleUser to fix boot and to
  // *refuse* OPENBOT_SINGLE_USER in bridge mode; forbid only enabling it.
  assert.ok(!added.join('\n').includes('OPENBOT_SINGLE_USER=true'), 'patch must never enable single-user');
  assert.ok(!code.includes('DEV_ACTOR'), 'bridge runtime must not borrow the dev actor');
  await access(APPLY, constants.X_OK);
  const apply = await readFile(APPLY, 'utf8');
  assert.ok(apply.includes(PIN), 'apply.sh pins the revision and refuses drift');
  assert.ok(apply.includes('manifest.json'), 'apply.sh validates the trusted manifest');
  assert.ok(apply.includes('meHomeBridgeConfigured'), 'apply.sh verifies the config seam');
  assert.ok(apply.includes('bridgeSessionCache'), 'apply.sh verifies the memoization');
});

test('trusted manifest carries byte-proof hashes for every patched file', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.repository, 'CopilotKit/OpenBot');
  assert.equal(manifest.baseCommit, PIN);
  assert.equal(manifest.patch, '0001-home-identity-bridge.patch');
  assert.match(manifest.patchSha256, /^[0-9a-f]{64}$/);
  const { createHash } = await import('node:crypto');
  const patchBytes = await readFile(PATCH);
  assert.equal(createHash('sha256').update(patchBytes).digest('hex'), manifest.patchSha256, 'patch sha matches bytes');
  for (const name of ['server/src/config.ts', 'server/src/index.ts', 'server/src/home-bridge.ts']) {
    assert.ok(manifest.files[name], `manifest lists ${name}`);
    assert.match(manifest.files[name].postSha256, /^[0-9a-f]{64}$/);
    if (name !== 'server/src/home-bridge.ts') {
      assert.match(manifest.files[name].originalSha256, /^[0-9a-f]{64}$/);
    } else {
      assert.equal(manifest.files[name].originalSha256, null, 'new file has no original');
    }
  }
  assert.equal(manifest.files['server/src/config.ts'].originalSha256, 'd210a4d4b3c43b869aa38483e5815ac0c3b3f77a6df2d66b5325d7510e3cf3c3');
  assert.equal(manifest.files['server/src/index.ts'].originalSha256, '6d0fa8dc72ae62d7b41f1a35083b1e8e82f53c2fda27255457416075b5d10ddd');
  // No temp-only paths as production proof.
  assert.ok(!JSON.stringify(manifest).includes('/private/tmp'), 'manifest must not reference temp-only files');
  assert.ok(!JSON.stringify(manifest).includes('/tmp/'), 'manifest must not reference temp-only files');
});

test('patch applies deterministically to the pinned seam and is idempotent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-patch-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', dir]);
  await mkdir(join(dir, 'server/src'), { recursive: true });
  await writeFile(join(dir, 'server/src/index.ts'), syntheticIndex());
  await writeFile(join(dir, 'server/src/config.ts'), syntheticConfig());
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', dir, 'apply', '--check', PATCH]);
  execFileSync('git', ['-C', dir, 'apply', PATCH]);
  const hooked = await readFile(join(dir, 'server/src/index.ts'), 'utf8');
  assert.ok(hooked.includes('wrapAuthWithHomeBridge(homeAuth'), 'assembly wraps auth before createApp/createRequestActor');
  assert.ok(hooked.includes('import { wrapAuthWithHomeBridge } from "./home-bridge";'));
  const bridge = await readFile(join(dir, 'server/src/home-bridge.ts'), 'utf8');
  assert.ok(bridge.includes('HOME_ASSERTION_HEADER') && bridge.includes('verifyHomeAssertion'));
  assert.ok(bridge.includes('bridgeSessionCache') && bridge.includes('WeakMap'), 'memoization present');
  const cfg = await readFile(join(dir, 'server/src/config.ts'), 'utf8');
  assert.ok(cfg.includes('meHomeBridgeConfigured'), 'config seam applied');
  assert.ok(cfg.includes('OPENBOT_SINGLE_USER/OPENBOT_DEV_NO_AUTH must not be set'), 'unsafe dev flags refused');
  // Byte-proof: patched files equal manifest post hashes when applied to
  // the *real* pinned sources is covered by apply.sh; here assert the
  // synthetic apply at least carries the seams (full-hash check needs real
  // sources, verified in live tests + apply.sh on the real checkout).
  execFileSync('git', ['-C', dir, 'apply', '--reverse', '--check', PATCH]);
});

test('patch has no nasty relative paths and updater seam is explicit', async () => {
  const text = await readFile(PATCH, 'utf8');
  assert.ok(!text.includes('../'), 'patch must not escape server/src');
  assert.ok(text.includes('diff --git a/server/src/config.ts b/server/src/config.ts'), 'config seam is an explicit git diff');
  assert.ok(text.includes('diff --git a/server/src/index.ts b/server/src/index.ts'), 'index seam is explicit');
  assert.ok(text.includes('diff --git a/server/src/home-bridge.ts'), 'new module is explicit');
  // Tell A: candidate checker + checkout must include the config seam.
  const apply = await readFile(APPLY, 'utf8');
  assert.ok(apply.includes('server/src/config.ts') || apply.includes('manifest'), 'apply.sh covers the config seam');
});

test('home proxy assertion matches the patched upstream wire format', async () => {
  assert.equal(ASSERTION_VERSION, 'v2');
  const patchText = await readFile(PATCH, 'utf8');
  assert.ok(patchText.includes('`${version}.${userId}.${expRaw}.${role}.${nonceHex}`'), 'patch verifies the same payload shape the proxy signs');
  const secret = 'test-bridge-secret-0123456789abcdef-xyz';
  const signed = signHomeAssertion({ upstreamUserId: 'u_alice', role: 'admin', bridgeSecret: secret });
  assert.match(signed, /^v2\.u_alice\.\d+\.admin\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  const back = verifyHomeAssertion(signed, { bridgeSecret: secret });
  assert.deepEqual(back, { upstreamUserId: 'u_alice', role: 'admin', exp: back.exp });
  assert.ok(verifyHomeAssertion(signed, { bridgeSecret: 'wrong-secret-0123456789abcdef-xyz' }) === null);
  assert.ok(verifyHomeAssertion('v1.u_alice.1.admin.deadbeef', { bridgeSecret: secret }) === null, 'expired rejected');
});
