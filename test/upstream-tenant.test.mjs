import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubset } from './yaml-subset.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'deploy/tenant-package/me');

// Rules transcribed 1:1 from the pinned upstream loader
// (server/src/tenant-package.ts @ 6bfee78...):
// - five required files: brand/agents/channels/model/knowledge.yaml
// - brand.tenant.{id, product_name} required non-empty
// - agents: [{id (required, not a DEPLOYMENT_ROUTE, not a person-browser id),
//   name, title (<=120), role_description, type built-in|remote-ag-ui|remote-mastra,
//   system_prompt (built-in) | endpoint (remote, blank => omitted)}]
// - channels: [{id unique, name, description, permitted_agents (deduped,
//   every entry a declared agent), allowed_groups}]
// - model: {provider openai|anthropic, credential_secret_ref, default_model}
// - knowledge: {sources: [{type google-drive|microsoft-onedrive, roots[]}]}
const DEPLOYMENT_ROUTES = new Set(['policy', 'fleet', 'policy-dry-run']);
const PERSON_BROWSER_RE = /^person-[0-9a-f]{32}$/;
const FORBIDDEN_CONTENT = ['fintech', 'finance', 'general-assistant', 'risk-analyst', 'risk-and-compliance', 'company-knowledge', 'compliance', 'openbotmobile'];
// Inline credential values (schema key names like credential_secret_ref are
// fine; assigned secret material is not).
const SECRET_VALUE_RE = /[:=]\s*['"]?(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9_-]*password[A-Za-z0-9_-]*\s*[:=]\s*\S+)/i;

const REQUIRED_FILES = ['brand.yaml', 'agents.yaml', 'channels.yaml', 'model.yaml', 'knowledge.yaml'];

async function load() {
  const out = {};
  for (const f of REQUIRED_FILES) {
    out[f] = parseSubset(await readFile(join(PKG, f), 'utf8'));
  }
  return out;
}

test('tenant package ships the five required native files, nothing sample', async (t) => {
  const entries = new Set(await readdir(PKG));
  for (const f of REQUIRED_FILES) assert.ok(entries.has(f), `missing required file ${f}`);
  // No skills.yaml (no skills shipped), no theme.css, no agents/ dir: minimal.
  assert.ok(!entries.has('skills.yaml'), 'skills.yaml must be absent (no skills shipped)');
  for (const f of entries) {
    assert.match(f, /^[a-z]+\.yaml$/, `unexpected package file ${f}`);
  }
  const raw = await Promise.all(REQUIRED_FILES.map((f) => readFile(join(PKG, f), 'utf8')));
  for (const [i, text] of raw.entries()) {
    for (const bad of FORBIDDEN_CONTENT) {
      assert.ok(!text.toLowerCase().includes(bad), `${REQUIRED_FILES[i]} contains sample/private content: ${bad}`);
    }
    assert.ok(!SECRET_VALUE_RE.test(text), `${REQUIRED_FILES[i]} contains inline credential material (use \${VAR} refs / secret names only)`);
  }
});

test('brand + agents: one personal Me agent on the native harness, fail-closed endpoint', async () => {
  const { 'brand.yaml': brand, 'agents.yaml': agentsYaml } = await load();
  assert.equal(brand.tenant.id, 'me-home');
  assert.equal(brand.tenant.product_name, 'Me');
  const agents = agentsYaml.agents;
  assert.ok(Array.isArray(agents) && agents.length >= 1, 'at least one agent');
  const ids = agents.map((a) => a.id);
  assert.deepEqual(ids, ['me'], 'exactly the personal Me agent (no sample/general roster)');
  const me = agents[0];
  assert.equal(me.type, 'remote-ag-ui', 'Me runs on the chosen native AG-UI harness');
  assert.equal(me.name, 'Me');
  assert.ok(me.title && me.title.length <= 120);
  assert.ok(me.role_description && me.role_description.length > 0);
  // Endpoint is a REQUIRED ${VAR} ref (no fallback): boot refuses without a
  // harness instead of silently omitting the only agent.
  assert.match(me.endpoint, /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, 'endpoint must be a bare required env ref (fail closed)');
  assert.ok(!('system_prompt' in me), 'remote agents carry no system_prompt');
  assert.ok(!('skills' in me), 'no unshipped skill slugs may be named');
  for (const a of agents) {
    assert.match(a.id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, `bad agent id ${a.id}`);
    assert.ok(!DEPLOYMENT_ROUTES.has(a.id), `agent id ${a.id} reserved for a deployment route`);
    assert.ok(!PERSON_BROWSER_RE.test(a.id), `agent id ${a.id} collides with a person browser id`);
    assert.ok(['built-in', 'remote-ag-ui', 'remote-mastra'].includes(a.type), `bad agent type ${a.type}`);
  }
});

test('channels: personal Me channel, cross-refs valid, nothing shared', async () => {
  const { 'agents.yaml': agentsYaml, 'channels.yaml': channelsYaml } = await load();
  const agentIds = new Set(agentsYaml.agents.map((a) => a.id));
  const channels = channelsYaml.channels;
  assert.ok(Array.isArray(channels) && channels.length >= 1);
  const ids = new Set();
  for (const c of channels) {
    assert.ok(c.id && !ids.has(c.id), `duplicate/empty channel id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.name && c.description);
    assert.ok(Array.isArray(c.permitted_agents));
    assert.equal(new Set(c.permitted_agents).size, c.permitted_agents.length, `channel ${c.id} lists an agent twice`);
    for (const a of c.permitted_agents) assert.ok(agentIds.has(a), `channel ${c.id} references unknown agent ${a}`);
    assert.ok(Array.isArray(c.allowed_groups));
  }
  const meChannel = channels.find((c) => c.id === 'me');
  assert.ok(meChannel, 'personal me channel exists');
  assert.deepEqual(meChannel.permitted_agents, ['me']);
});

test('model + knowledge: same native selection, no sample sources', async () => {
  const { 'model.yaml': modelYaml, 'knowledge.yaml': knowledgeYaml } = await load();
  const model = modelYaml.model;
  // ${VAR} refs (expanded by the upstream loader) or literal enum values.
  const providerOk = model.provider === 'openai' || model.provider === 'anthropic' ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(model.provider);
  assert.ok(providerOk, `model.provider must be openai|anthropic or an env ref, got ${model.provider}`);
  assert.ok(model.credential_secret_ref && typeof model.credential_secret_ref === 'string');
  assert.ok(model.default_model && typeof model.default_model === 'string');
  // Default model tracks the harness default (gpt-5.5) unless overridden.
  assert.ok(model.default_model.includes('gpt-5.5') || model.default_model.startsWith('${'), `default_model tracks BOT_MODEL, got ${model.default_model}`);
  assert.ok(Array.isArray(knowledgeYaml.sources), 'knowledge.sources must be a list');
  for (const s of knowledgeYaml.sources) {
    assert.ok(['google-drive', 'microsoft-onedrive'].includes(s.type));
    assert.ok(Array.isArray(s.roots));
  }
});
