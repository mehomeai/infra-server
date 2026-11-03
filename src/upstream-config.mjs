// Upstream computer-platform configuration (upstream-platform-v1).
//
// REQUIRED CORE works without any CopilotKit license: per-user agent-computer
// + supervisor only. OPTIONAL FULL platform profile (Postgres server +
// routines + Intelligence) is gated and NEVER ready without licensed
// self-hosted Intelligence. No managed cloud conversation storage under home
// privacy default.
//
// Env (all host-operator, never phone client):
//   ME_UPSTREAM_MODE=core|full (default core)
//   COMPUTER_SUPERVISOR_URL, SUPERVISOR_TOKEN, COMPUTER_TOKEN, COMPUTER_IMAGE,
//   COMPUTER_NAMESPACE (upstream supervisor/computer)
//   OPENBOT_CHECKOUT (pinned git checkout path, default /opt/openbot)
//   Full only: DATABASE_URL, KEY_ENCRYPTION_KEY, INTELLIGENCE_API_URL,
//     INTELLIGENCE_GATEWAY_WS_URL, CPK_INTELLIGENCE_API_KEY,
//     COPILOTKIT_LICENSE_TOKEN (self-hosted), provider OAuth set.
// Fail-closed: unsafe OPENBOT_SINGLE_USER=true on shared/home never READY.

export const UPSTREAM_PIN = '6bfee780c8e8d05141375ea55ebde33eefb3dbc0';
export const UPSTREAM_REPO = 'CopilotKit/OpenBot';

export function upstreamConfigError(message, code = 'upstream_not_configured') {
  return Object.assign(new Error(message), { code });
}

function nonEmpty(env, name) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  return String(v).trim();
}

function isManagedIntelligenceUrl(url) {
  return /copilotkit\.ai/i.test(String(url || ''));
}

export function resolveUpstreamConfig(env = process.env) {
  const mode = (env.ME_UPSTREAM_MODE ?? 'core').trim().toLowerCase();
  if (mode !== 'core' && mode !== 'full') {
    throw upstreamConfigError('ME_UPSTREAM_MODE must be core or full');
  }
  const supervisorUrl = nonEmpty(env, 'COMPUTER_SUPERVISOR_URL') ?? nonEmpty(env, 'ME_UPSTREAM_SUPERVISOR_URL');
  const supervisorToken = nonEmpty(env, 'SUPERVISOR_TOKEN');
  const computerToken = nonEmpty(env, 'COMPUTER_TOKEN');
  const computerImage = nonEmpty(env, 'COMPUTER_IMAGE') ?? 'openbot-agent-computer:latest';
  const namespace = nonEmpty(env, 'COMPUTER_NAMESPACE') ?? 'openbot';
  const checkout = nonEmpty(env, 'OPENBOT_CHECKOUT') ?? '/opt/openbot';
  // Home privacy default: managed cloud conversation storage is opt-in only.
  const allowManaged = ['1', 'true'].includes(String(env.ME_UPSTREAM_ALLOW_MANAGED_INTELLIGENCE ?? '').trim().toLowerCase());

  if (mode === 'core') {
    // CORE needs only the computer plane. Tokens are required to select a
    // private computer; without them the mode is NEEDS_INPUT, never a silent
    // fallback to the legacy custom runner.
    const missing = [];
    if (!supervisorUrl) missing.push('COMPUTER_SUPERVISOR_URL');
    if (!supervisorToken) missing.push('SUPERVISOR_TOKEN');
    if (!computerToken) missing.push('COMPUTER_TOKEN');
    return {
      mode, upstream: { repo: UPSTREAM_REPO, ref: UPSTREAM_PIN },
      computer: { supervisorUrl, supervisorToken, computerToken, computerImage, namespace, checkout },
      missing,
      full: null,
      allowManaged,
    };
  }

  // FULL profile: entire upstream server + Postgres + routines + Intelligence.
  const full = {
    databaseUrl: nonEmpty(env, 'DATABASE_URL'),
    keyEncryptionKey: nonEmpty(env, 'KEY_ENCRYPTION_KEY'),
    bridgeSecret: nonEmpty(env, 'ME_HOME_BRIDGE_SECRET'),
    intelligenceApiUrl: nonEmpty(env, 'INTELLIGENCE_API_URL'),
    intelligenceGatewayWsUrl: nonEmpty(env, 'INTELLIGENCE_GATEWAY_WS_URL'),
    intelligenceKey: nonEmpty(env, 'CPK_INTELLIGENCE_API_KEY') ?? nonEmpty(env, 'INTELLIGENCE_API_KEY'),
    licenseToken: nonEmpty(env, 'COPILOTKIT_LICENSE_TOKEN'),
    betterAuthUrl: nonEmpty(env, 'BETTER_AUTH_URL'),
    betterAuthSecret: nonEmpty(env, 'BETTER_AUTH_SECRET'),
    initialAdminEmails: nonEmpty(env, 'INITIAL_ADMIN_EMAILS'),
    trustedOrigins: nonEmpty(env, 'TRUSTED_ORIGINS'),
    singleUser: ['1', 'true'].includes(String(env.OPENBOT_SINGLE_USER ?? '').trim().toLowerCase()),
    computer: { supervisorUrl, supervisorToken, computerToken, computerImage, namespace, checkout },
  };
  const missing = [];
  for (const [k, v] of Object.entries({
    DATABASE_URL: full.databaseUrl,
    KEY_ENCRYPTION_KEY: full.keyEncryptionKey,
    ME_HOME_BRIDGE_SECRET: full.bridgeSecret,
    INTELLIGENCE_API_URL: full.intelligenceApiUrl,
    INTELLIGENCE_GATEWAY_WS_URL: full.intelligenceGatewayWsUrl,
    CPK_INTELLIGENCE_API_KEY: full.intelligenceKey,
    BETTER_AUTH_URL: full.betterAuthUrl,
    BETTER_AUTH_SECRET: full.betterAuthSecret,
    INITIAL_ADMIN_EMAILS: full.initialAdminEmails,
  })) if (!v) missing.push(k);
  // Computer plane still required in full.
  if (!supervisorUrl) missing.push('COMPUTER_SUPERVISOR_URL');
  if (!supervisorToken) missing.push('SUPERVISOR_TOKEN');
  if (!computerToken) missing.push('COMPUTER_TOKEN');
  return {
    mode, upstream: { repo: UPSTREAM_REPO, ref: UPSTREAM_PIN },
    computer: full.computer, missing, full, allowManaged,
  };
}

// Fail-closed gate for FULL: returns {ok:true} or {ok:false, reason}.
// - unsafe SINGLE_USER on shared/home
// - missing fields
// - managed Intelligence URL without explicit opt-in (privacy default)
// - example/placeholder secrets (upstream refuses KEY_ENCRYPTION_KEY example in prod)
export function gateFullConfig(resolved) {
  if (resolved.mode !== 'full') return { ok: true };
  const f = resolved.full;
  if (f.singleUser) {
    return { ok: false, reason: 'OPENBOT_SINGLE_USER=true is dev-only; refusing shared/home FULL profile' };
  }
  if (resolved.missing.length > 0) {
    return { ok: false, reason: `FULL profile missing: ${resolved.missing.join(', ')}` };
  }
  if (isManagedIntelligenceUrl(f.intelligenceApiUrl) && !resolved.allowManaged) {
    return { ok: false, reason: 'managed Intelligence URL refused under home privacy default (set ME_UPSTREAM_ALLOW_MANAGED_INTELLIGENCE=1 to opt in explicitly)' };
  }
  if (f.keyEncryptionKey === 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') {
    return { ok: false, reason: 'KEY_ENCRYPTION_KEY example value refused in production' };
  }
  if ((f.bridgeSecret ?? '').length < 32) {
    return { ok: false, reason: 'ME_HOME_BRIDGE_SECRET must be >=32 chars (dedicated bridge secret, fail closed)' };
  }
  if ((f.betterAuthSecret ?? '').length < 32) {
    return { ok: false, reason: 'BETTER_AUTH_SECRET must be >=32 chars' };
  }
  return { ok: true };
}
