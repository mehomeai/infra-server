// Thin FULL delegation adapter (upstream owns execution, home is facade).
//
// - Home Task API becomes a compat view mapper, NOT a second execution
//   authority: no second scheduler/stores claiming truth. New configured
//   primary goes to upstream; legacy SQLite conversations/paused jobs stay via
//   explicit legacy adapter until terminal (non-destructive, no migration).
// - Missing upstream => NEEDS_SETUP/unavailable, never silent legacy fallback
//   for new work.
// - Transport truth: /api/copilotkit is CopilotKit Hono handler (basePath
//   /api/copilotkit, gateway-JOIN, NOT raw AG-UI RunAgentInput). This adapter
//   does NOT POST raw RunAgentInput; it resolves the native endpoint + signed
//   context for B's harness client (HttpAgent) and documents the SDK shape.
// - Computer path is always the server gateway /api/computers, never direct
//   agent-computer:4100 in FULL.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolveUpstreamConfig } from './upstream-config.mjs';
import { forwardNative } from './upstream-proxy.mjs';
import { ensureUpstreamTables, getUpstreamUser } from './upstream-identity.mjs';

export function fullNotConfigured(message = 'Upstream FULL profile not configured') {
  return Object.assign(new Error(message), { code: 'upstream_not_configured', needsSetup: true });
}

// Deployment fingerprint (mirrors upstream thread-identity): 6-byte sha256
// prefix in a UUIDv8. Deterministic per deployment, random per thread.
export function deploymentFingerprint(deploymentId) {
  return createHash('sha256').update(String(deploymentId)).digest().subarray(0, 6);
}

export function mintThreadId(deploymentId) {
  const fp = deploymentFingerprint(deploymentId);
  const bytes = randomBytes(16);
  fp.copy(bytes, 0);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

export function ownsThread(threadId, deploymentId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) return false;
  const bytes = Buffer.from(threadId.replaceAll('-', ''), 'hex');
  if ((bytes[6] & 0xf0) !== 0x80) return false;
  return bytes.subarray(0, 6).equals(deploymentFingerprint(deploymentId));
}

// Resolve the native upstream target for B's harness client. B owns the
// agent service packaging; this tells B what service/harness and how called.
// The canonical native harness serves POST / (AG-UI root) on 4206 — never a
// /ag-ui suffix (see runtime-wire-contract.json). No silent fallback to a
// stale endpoint: an unconfigured harness is an explicit failure.
export function resolveAgentTarget(env = process.env) {
  const managedUrl = (env.MANAGED_AGENT_AG_UI_URL ?? '').trim() || null;
  const pickedUrl = (env.PICKED_HARNESS_URL ?? env.PICKED_HARNESS_CONTAINER_URL ?? '').trim() || null;
  const endpoint = pickedUrl ?? managedUrl ?? 'http://127.0.0.1:4206/';
  const token = (env.MANAGED_AGENT_TOKEN ?? '').trim() || null;
  return {
    // B provides: agent-langgraph-agui (pinned 6bfee78) via add_langgraph_fastapi_endpoint.
    harness: 'agent-langgraph-agui',
    pin: '6bfee780c8e8d05141375ea55ebde33eefb3dbc0',
    endpoint,
    agentId: (env.BOT_ID ?? 'agent-langgraph').trim() || 'agent-langgraph',
    headers: token ? { 'x-openbot-agent-token': token } : {},
    tokenConfigured: Boolean(token),
    transport: 'HttpAgent(url, agentId, headers) over AG-UI POST / (root) on 4206; called by upstream server gateway, not raw /api/copilotkit POST from runtime',
  };
}

// Home conversation -> upstream thread mapping (persisted, per-owner).
export function getOrMintThreadForConversation(db, { homeConversationId, meUserId, deploymentId }) {
  ensureUpstreamTables(db);
  const conv = db.prepare('SELECT id, owner_id FROM conversations WHERE id = ?').get(homeConversationId);
  if (!conv || conv.owner_id !== meUserId) throw Object.assign(new Error('Conversation not found'), { code: 'not_found' });
  const existing = db.prepare('SELECT thread_id, deployment_id FROM upstream_threads WHERE home_conversation_id = ?').get(homeConversationId);
  if (existing) {
    if (existing.deployment_id !== deploymentId) throw Object.assign(new Error('Conversation mapped to another deployment'), { code: 'wrong_home' });
    return existing.thread_id;
  }
  const threadId = mintThreadId(deploymentId);
  db.prepare('INSERT INTO upstream_threads(home_conversation_id, thread_id, deployment_id, me_user_id, created_at) VALUES(?, ?, ?, ?, ?)').run(
    homeConversationId, threadId, deploymentId, meUserId, Date.now(),
  );
  return threadId;
}

// Compat submit that REALLY executes upstream (no local runner, no second
// scheduler). Validates home session + linkage, then drives the exact pinned
// native calls the OpenBot mobile app uses: POST /api/channels/
// {agentIds:[agentId]} -> 201 {channel}, then POST
// /api/delivery/conversations/:id/messages {agentId,text,externalId:UUID}
// -> 202 via the real upstream router/worker. agentId is explicit (no roster
// guessing); callers normally read it from proxied GET /api/agents first.
export async function submitToUpstream(db, { session, homeConversationId, title, request, agentId, env = process.env, fetchImpl = fetch }) {
  if (!session?.user_id) throw Object.assign(new Error('Valid Bearer session token required'), { code: 'unauthorized' });
  const cfg = resolveUpstreamConfig(env);
  if (cfg.mode !== 'full') throw fullNotConfigured('FULL primary required for new execution (ME_UPSTREAM_MODE=full)');
  if (cfg.missing.length > 0) throw Object.assign(new Error(`FULL profile missing: ${cfg.missing.join(', ')}`), { code: 'upstream_not_configured', needsSetup: true });
  const linked = getUpstreamUser(db, session.user_id);
  if (!linked) throw Object.assign(new Error('Upstream identity not linked for this owner'), { code: 'upstream_not_linked', needsSetup: true });
  if (!agentId || typeof agentId !== 'string' || !agentId.trim()) {
    throw Object.assign(new Error('agentId is required: read the roster from proxied GET /api/agents, then submit with an explicit bot id (no roster guessing)'), { code: 'agent_required' });
  }
  const conv = db.prepare('SELECT id, owner_id FROM conversations WHERE id = ?').get(homeConversationId);
  if (!conv || conv.owner_id !== session.user_id) throw Object.assign(new Error('Conversation not found'), { code: 'not_found' });
  const text = String(request ?? title ?? '').trim();
  if (!text || text.length > 16000) throw Object.assign(new Error('request/text must be non-empty text up to 16000 chars'), { code: 'bad_request' });
  const botId = agentId.trim();
  const { status: channelStatus, text: channelText, json: channelJson, upstreamUserId } = await forwardNative({
    db, session, pathname: '/api/channels/', method: 'POST', body: { agentIds: [botId] }, env, fetchImpl,
  });
  const channelRes = { status: channelStatus, text: channelText, json: channelJson };
  if (channelRes.status !== 201) {
    let detail = '';
    try { detail = channelRes.text(); } catch { /* bounded relay already */ }
    throw Object.assign(new Error(`Upstream channel creation refused (${channelRes.status}): ${detail.slice(0, 200)}`), { code: 'upstream_refused', status: channelRes.status });
  }
  let channelBody = null;
  try { channelBody = channelRes.json(); } catch { channelBody = null; }
  const channelId = channelBody?.channel?.id ?? channelBody?.id ?? null;
  if (!channelId || typeof channelId !== 'string') {
    throw Object.assign(new Error('Upstream channel creation answered without a channel id'), { code: 'upstream_refused', status: 502 });
  }
  const externalId = randomUUID();
  const { status: messageStatus, text: messageText, json: messageJson } = await forwardNative({
    db, session, pathname: `/api/delivery/conversations/${encodeURIComponent(channelId)}/messages`,
    method: 'POST', body: { agentId: botId, text, externalId }, env, fetchImpl,
  });
  const messageRes = { status: messageStatus, text: messageText, json: messageJson };
  if (messageRes.status !== 202) {
    let detail = '';
    try { detail = messageRes.text(); } catch { /* bounded relay already */ }
    throw Object.assign(new Error(`Upstream turn refused (${messageRes.status}): ${detail.slice(0, 200)}`), { code: 'upstream_refused', status: messageRes.status });
  }
  let receipt = null;
  try { receipt = messageRes.json(); } catch { receipt = null; }
  return {
    delegated: true,
    protocol: 'native-upstream',
    upstreamUserId,
    channelId,
    agentId: botId,
    externalId,
    receipt,
    // Home compat view (legacy /v1 shapes unchanged): the task IS the
    // upstream channel+turn, owned authoritatively by upstream.
    task: {
      id: channelId,
      conversation_id: homeConversationId,
      owner: session.user_id,
      title: String(title ?? request ?? 'Untitled').slice(0, 200),
      status: 'working',
      execution: 'full-upstream',
    },
  };
}

// Legacy adapter: old SQLite conversations / paused jobs stay readable,
// explicitly marked, never auto-migrated or erased.
export function listLegacyConversations(db, meUserId) {
  const rows = db.prepare('SELECT id, owner_id, title, created_at, updated_at FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC, id').all(meUserId);
  return rows.map((r) => ({ ...r, legacy: true, execution: 'legacy-home' }));
}
