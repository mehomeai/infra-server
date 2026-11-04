import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal YAML-subset reader (maps + nesting + inline scalars only; the
// values overlays use no anchors/aliases/multiline). Dependency-free so it
// runs everywhere the home suite runs.
function parseSubset(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) throw new Error(`unparseable line: ${line}`);
    const key = m[1].trim();
    let value = m[2].trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (value === '') {
      parent[key] = {};
      stack.push({ indent, node: parent[key] });
    } else {
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (value === '[]') value = [];
      else if (/^-?\d+$/.test(value)) value = Number(value);
      parent[key] = value;
    }
  }
  return root;
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Official chart value paths (docs.copilotkit.ai/intelligence/self-hosting
// configuration reference). The overlay must not invent keys outside these.
const KNOWN_PREFIXES = [
  'global.', 'database.', 'redis.', 'redis-subchart.', 'postgresql.',
  'openSearch.', 'auth.', 'ingress.', 'appApi.', 'appFrontend.',
  'realtimeGateway.', 'externalSecrets.', 'selfHostedSecrets.',
  'postgresql.', 'redis-subchart.', 'keycloak.', 'objectStorage.',
  'migrations.', 'threadCuller.', 'config.',
];

function collectPaths(node, prefix = '', out = []) {
  for (const [k, v] of Object.entries(node ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) collectPaths(v, p, out);
  }
  return out;
}

test('intelligence overlay uses only official chart keys (no invented values)', async () => {
  const text = await readFile(join(ROOT, 'deploy/upstream-intelligence-values.yaml'), 'utf8');
  const values = parseSubset(text);
  for (const p of collectPaths(values)) {
    assert.ok(KNOWN_PREFIXES.some((k) => p === k.slice(0, -1) || p.startsWith(k)),
      `invented chart value (not in official schema): ${p}`);
  }
});

test('intelligence overlay enforces the single-node home profile', async () => {
  const text = await readFile(join(ROOT, 'deploy/upstream-intelligence-values.yaml'), 'utf8');
  const values = parseSubset(text);
  assert.equal(get(values, 'migrations.enabled'), true, 'migrations required for first install');
  assert.equal(get(values, 'realtimeGateway.enabled'), true, 'native pipeline needs the gateway');
  assert.equal(get(values, 'threadCuller.enabled'), false, 'destructive culler stays disabled');
  assert.equal(get(values, 'appApi.replicaCount'), 1, 'single-node default');
  assert.equal(get(values, 'appApi.autoscaling.enabled'), false, 'no autoscaling on single-node default');
  assert.equal(get(values, 'postgresql.enabled'), true, 'local-owned Postgres default (no managed RDS)');
  assert.equal(get(values, 'redis-subchart.enabled'), true, 'local-owned Redis default');
  assert.equal(get(values, 'database.host'), '', 'managed host is an explicit override, not the default');
  // Secrets discipline: no inline credentials anywhere in the repo overlay.
  const secretish = ['database.existingSecret', 'redis.existingSecret', 'auth.existingSecret', 'appApi.licenseSecret.existingSecret'];
  for (const p of secretish) {
    const v = get(values, p);
    if (typeof v === 'string' && v) assert.ok(!/^(pass|token|key|sk-)/i.test(v), `${p} must reference a Secret name, not inline material`);
  }
});
