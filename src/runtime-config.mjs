// Home-selected runtime/model/capability configuration (H2/H3).
//
// The home — never the phone client — selects the model and the capability
// ceiling. Client task requests may narrow capabilities but can never widen
// them, and a client-supplied `model` is rejected outright.
//
// H3 hardening: capability values must be real booleans (truthy strings,
// numbers, arrays, and objects are rejected, never coerced — Python truthiness
// must not grant what a false host ceiling denies). Capability maps must be
// plain objects; arrays, unknown fields, and malformed budgets are rejected.

export const DEFAULT_BUDGETS = { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 };
export const MAX_BUDGETS = { max_steps: 32, max_wall_seconds: 600, max_tool_calls: 100 };

// Structured argv wins. ME_RUNTIME_ARGV is a JSON array of 1+ non-empty
// strings (safe for executable/cwd paths containing spaces). The legacy
// ME_RUNTIME_CMD string is only kept for quote-free commands: anything with
// quote characters is rejected so naive whitespace splitting can never mangle
// a grouped path. The child is always spawned with shell:false.
export function resolveRuntimeCommand(env = process.env) {
  if (env.ME_RUNTIME_ARGV != null && String(env.ME_RUNTIME_ARGV).trim() !== '') {
    let argv;
    try {
      argv = JSON.parse(env.ME_RUNTIME_ARGV);
    } catch {
      throw runtimeError('ME_RUNTIME_ARGV must be a JSON array of strings');
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((part) => typeof part !== 'string' || part.length === 0)
    ) {
      throw runtimeError('ME_RUNTIME_ARGV must be a JSON array of 1+ non-empty strings');
    }
    return { command: argv, cwd: env.ME_RUNTIME_CWD || undefined };
  }
  const raw = (env.ME_RUNTIME_CMD ?? 'python3 -m me_runtime.bridge').trim();
  if (!raw) throw runtimeError('ME_RUNTIME_CMD must not be empty');
  if (/['"]/.test(raw)) {
    throw runtimeError(
      'ME_RUNTIME_CMD contains quote characters; use ME_RUNTIME_ARGV (JSON array) for paths with spaces',
    );
  }
  return { command: raw.split(/\s+/), cwd: env.ME_RUNTIME_CWD || undefined };
}

export function runtimeError(message) {
  return Object.assign(new Error(message), { code: 'runtime_not_configured' });
}

// Throws {code:'model_not_configured'} when the home has no usable model.
// Fixture models are dev/test-only and require explicit opt-in. Remote
// providers keep their own identity (never relabeled as local); a trusted
// HOME_MODEL_ENDPOINT for a compatible API style is passed through when set.
export function resolveModelConfig(env = process.env) {
  const provider = (env.HOME_MODEL_PROVIDER ?? 'unconfigured').trim();
  if (provider === 'fixture') {
    if (env.HOME_ALLOW_FIXTURE_MODEL !== '1') {
      throw configError(
        'Fixture models require HOME_ALLOW_FIXTURE_MODEL=1 (development/tests only)',
      );
    }
    return { provider: 'fixture', model: env.HOME_MODEL_NAME?.trim() || 'fixture-echo' };
  }
  if (provider === 'local') {
    return {
      provider: 'local',
      model: env.HOME_MODEL_NAME?.trim() || 'llama3.1',
      // Native Ollama API (ChatOllama); the /v1 OpenAI-compatible path is not
      // used here. An explicit HOME_MODEL_ENDPOINT still wins when set.
      endpoint: env.HOME_MODEL_ENDPOINT?.trim() || 'http://127.0.0.1:11434',
    };
  }
  if (provider === 'openai' || provider === 'anthropic') {
    if (env.ME_RUNTIME_ALLOW_REMOTE !== '1') {
      throw configError(`${provider} requires ME_RUNTIME_ALLOW_REMOTE=1 (explicit remote opt-in)`);
    }
    if (!env.ME_RUNTIME_MODEL_API_KEY) {
      throw configError(`${provider} requires ME_RUNTIME_MODEL_API_KEY to be set on the home host`);
    }
    const config = {
      provider,
      model: env.HOME_MODEL_NAME?.trim() || (provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5'),
      api_key_env: 'ME_RUNTIME_MODEL_API_KEY',
    };
    if (env.HOME_MODEL_ENDPOINT?.trim()) {
      config.endpoint = env.HOME_MODEL_ENDPOINT.trim();
    }
    // Meta-compatible OpenAI Responses API style (R3 runtime reads
    // `use_responses_api` on the model object). Trusted host flag only —
    // never settable by phone clients (the submit route rejects `model`).
    // Attached for provider=openai only, matching runtime semantics.
    if (provider === 'openai' && parseEnvBool(env.HOME_MODEL_USE_RESPONSES_API, 'HOME_MODEL_USE_RESPONSES_API')) {
      config.use_responses_api = true;
    }
    return config;
  }
  throw configError(
    'No model configured: set HOME_MODEL_PROVIDER=local (Ollama default) or an explicit remote provider; fixture is dev-only',
  );
}

export function configError(message) {
  return Object.assign(new Error(message), { code: 'model_not_configured' });
}

export function isConfigError(error) {
  return Boolean(error) && (error.code === 'model_not_configured' || error.code === 'runtime_not_configured');
}

// Strict trusted-boolean parsing for home host flags. Only explicit true/false
// spellings are accepted; anything else is a configuration error, never a
// guess. Never applied to client input.
export function parseEnvBool(raw, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const value = String(raw).trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw configError(`${name} must be 1/true or 0/false (got ${JSON.stringify(raw)})`);
}

// Narrow-by-default capability ceiling. Code/network/renderer actions require
// explicit host opt-in; the runtime additionally jails and denies by default.
export function resolveCapabilityPolicy(env = process.env) {
  const egress = (env.HOME_CAP_EGRESS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    files: true,
    web_fetch: env.HOME_CAP_WEB_FETCH === '1',
    browser: env.HOME_CAP_BROWSER === '1',
    code_exec: env.HOME_CAP_CODE_EXEC === '1' && env.ME_RUNTIME_ALLOW_CODE_EXEC === '1',
    animation: env.HOME_CAP_ANIMATION === '1',
    network_egress_allowlist: egress,
  };
}

// Merge a client request with the home ceiling: narrowing allowed, widening
// rejected with {code:'capability_denied'}. Every presented value is strictly
// validated — truthy non-booleans never pass.
export function clampCapabilities(requested, policy) {
  if (requested === undefined || requested === null) requested = {};
  if (typeof requested !== 'object' || Array.isArray(requested)) {
    throw capabilityError('capabilities must be an object');
  }
  const allowedKeys = ['files', 'web_fetch', 'browser', 'code_exec', 'animation'];
  for (const key of Object.keys(requested)) {
    if (key !== 'network_egress_allowlist' && !allowedKeys.includes(key)) {
      throw capabilityError(`Unknown capability: ${key}`);
    }
  }
  const out = { network_egress_allowlist: [] };
  for (const key of allowedKeys) {
    const value = requested[key] ?? (key === 'files');
    if (typeof value !== 'boolean') {
      throw capabilityError(`Capability ${key} must be a boolean`);
    }
    if (value === true && policy[key] !== true) {
      throw capabilityError(`Capability not enabled on this home: ${key}`);
    }
    out[key] = value;
  }
  const allowlist = requested.network_egress_allowlist ?? [];
  if (!Array.isArray(allowlist) || allowlist.some((h) => typeof h !== 'string' || h.length === 0)) {
    throw capabilityError('network_egress_allowlist must be an array of non-empty strings');
  }
  for (const host of allowlist) {
    if (!policy.network_egress_allowlist.includes(host)) {
      throw capabilityError(`Egress host not allowlisted on this home: ${host}`);
    }
  }
  out.network_egress_allowlist = allowlist;
  return out;
}

export function capabilityError(message) {
  return Object.assign(new Error(message), { code: 'capability_denied' });
}

// Durable subtask delegation bounds (H6). Conservative small defaults;
// any 0 disables child spawning entirely (submit_child rejected).
// Root tasks via HTTP are never blocked by these limits — they bound
// fanout/depth/total-under-root only. Model policy can never raise these
// bounds; they are host-operator ceilings. Budgets remain per-run; there is
// no aggregated root-cost accounting.
export const DEFAULT_DELEGATION = { maxFanout: 3, maxDepth: 1, maxTasksPerRoot: 4 };
export function resolveDelegationConfig(env = process.env) {
  const num = (raw, fallback, name, min = 0, max = 200) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw Object.assign(new Error(`${name} must be an integer ${min}..${max} (got ${JSON.stringify(raw)})`), {
        code: 'bad_request',
      });
    }
    return value;
  };
  const fanoutRaw = env.HOME_DELEGATION_MAX_FANOUT ?? env.HOME_DELEGATION_MAX_CHILDREN;
  return {
    maxFanout: num(fanoutRaw, DEFAULT_DELEGATION.maxFanout, 'HOME_DELEGATION_MAX_FANOUT', 0, 50),
    maxDepth: num(env.HOME_DELEGATION_MAX_DEPTH, DEFAULT_DELEGATION.maxDepth, 'HOME_DELEGATION_MAX_DEPTH', 0, 10),
    maxTasksPerRoot: num(env.HOME_DELEGATION_MAX_TASKS_PER_ROOT, DEFAULT_DELEGATION.maxTasksPerRoot, 'HOME_DELEGATION_MAX_TASKS_PER_ROOT', 0, 200),
  };
}

export function isDelegationEnabled(delegation) {
  if (!delegation) return false;
  return delegation.maxFanout > 0 && delegation.maxDepth > 0 && delegation.maxTasksPerRoot > 0;
}

export function clampBudgets(requested) {
  if (requested === undefined || requested === null) requested = {};
  if (typeof requested !== 'object' || Array.isArray(requested)) {
    throw Object.assign(new Error('budgets must be an object'), { code: 'bad_request' });
  }
  const allowed = ['max_steps', 'max_wall_seconds', 'max_tool_calls'];
  for (const key of Object.keys(requested)) {
    if (!allowed.includes(key)) {
      throw Object.assign(new Error(`Unknown budget: ${key}`), { code: 'bad_request' });
    }
  }
  const out = {};
  for (const key of allowed) {
    const value = requested[key] ?? DEFAULT_BUDGETS[key];
    if (!Number.isInteger(value) || value < 1 || value > MAX_BUDGETS[key]) {
      throw Object.assign(new Error(`${key} must be an integer 1..${MAX_BUDGETS[key]}`), {
        code: 'bad_request',
      });
    }
    out[key] = value;
  }
  return out;
}
