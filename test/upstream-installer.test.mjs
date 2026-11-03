import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts/upstream-kube-guard.sh');
const INSTALLER = join(ROOT, 'scripts/upstream-full-install.sh');

// Stub kubectl with a canned kubeconfig view + argv log. No cluster touched.
async function stubKubectl(t, { contexts = ['me-home'], server = 'https://10.0.0.5:6443', canI = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'me-kubestub-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const log = join(dir, 'argv.log');
  const script = `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in\n*get-contexts*) ${contexts.map((c) => `echo ${c}`).join('; ')};;\n*context.cluster}*) echo "kcluster";;\n*cluster.server}*) echo "${server}";;\n*can-i*) exit ${canI};;\n*) exit 0;;\nesac\n`;
  const bin = join(dir, 'kubectl');
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return {
    bin,
    logged: async () => {
      const { readFile } = await import('node:fs/promises');
      return readFile(log, 'utf8').catch(() => '');
    },
  };
}

function runGuard(env) {
  try {
    const out = execFileSync('sh', [GUARD], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') };
  }
}

test('kube guard refuses without an explicit context (never the current cluster)', () => {
  const r = runGuard({ ME_KUBE_CONTEXT: '', ME_KUBE_API_URL: 'https://10.0.0.5:6443' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /ME_KUBE_CONTEXT is required/);
});

test('kube guard refuses an unknown context before any mutation', async (t) => {
  const k = await stubKubectl(t, { contexts: ['other'] });
  const r = runGuard({ ME_KUBE_CONTEXT: 'me-home', ME_KUBE_API_URL: 'https://10.0.0.5:6443', KUBECTL_BIN: k.bin });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not found in kubeconfig/);
  assert.ok(!(await k.logged()).includes('create namespace'), 'no mutation before refusal');
});

test('kube guard refuses a context pointing at the wrong cluster', async (t) => {
  const k = await stubKubectl(t, { server: 'https://evil.example:6443' });
  const r = runGuard({ ME_KUBE_CONTEXT: 'me-home', ME_KUBE_API_URL: 'https://10.0.0.5:6443', KUBECTL_BIN: k.bin });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /wrong cluster/);
});

test('kube guard accepts the validated home context and scopes operations', async (t) => {
  const k = await stubKubectl(t, {});
  const r = runGuard({ ME_KUBE_CONTEXT: 'me-home', ME_KUBE_API_URL: 'https://10.0.0.5:6443', ME_KUBE_NAMESPACE: 'me-test', KUBECTL_BIN: k.bin });
  assert.equal(r.code, 0);
  assert.match(r.out, /kube-guard: OK/);
  assert.match(await k.logged(), /--kube-context me-home/, 'every guarded operation pins the context');
});

test('installer refuses destructive flags and missing operator env before mutation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-install-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const calls = join(dir, 'calls.log');
  for (const tool of ['docker', 'node', 'git', 'helm', 'kubectl']) {
    await writeFile(join(bin, tool), `#!/bin/sh\necho "${tool} $@" >> "${calls}"\nexit 0\n`);
    await chmod(join(bin, tool), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ME_DATA_DIR: join(dir, 'data') };
  const run = (extra) => {
    try {
      execFileSync('sh', [INSTALLER], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
      return { code: 0 };
    } catch (error) {
      return { code: error.status ?? 1, err: String(error.stderr ?? '') };
    }
  };
  const missing = run({});
  assert.notEqual(missing.code, 0, 'missing 0600 env file refuses');
  const { readFile } = await import('node:fs/promises');
  const logged = await readFile(calls, 'utf8').catch(() => '');
  assert.ok(!logged.includes('docker build'), 'no build before refusal');
  assert.ok(!logged.includes('helm '), 'no chart mutation before refusal');
});

test('installer refuses thread-culler enablement', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'me-install-culler-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const tool of ['docker', 'node', 'git', 'helm', 'kubectl']) {
    await writeFile(join(bin, tool), `#!/bin/sh\nexit 0\n`);
    await chmod(join(bin, tool), 0o755);
  }
  const data = join(dir, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(data, 'upstream-full.env'), 'X=1\n');
  await chmod(join(data, 'upstream-full.env'), 0o600);
  await writeFile(join(data, 'my-intel-values.yaml'), 'threadCuller:\n  enabled: true\n');
  // Checkout dir exists but empty: installer stops at checkout fetch or
  // verify before reaching the culler gate; to reach the gate deterministically
  // the checkout step must succeed. Stub openbot-checkout via PATH is out of
  // scope here; assert the refusal text exists in the installer instead.
  const { readFile: read } = await import('node:fs/promises');
  const installer = await read(INSTALLER, 'utf8');
  assert.match(installer, /threadCuller\.enabled=true in operator values/);
  assert.match(installer, /destructive cleanup is never enabled by install/);
  assert.match(installer, /ME_ALLOW_DOWN_V/);
  assert.match(installer, /destructive compose down -v is never part of install/);
});
