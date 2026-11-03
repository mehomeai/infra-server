import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TaskWorker, LostLeaseError } from '../vendor/openmuse/apps/server/src/engine/worker.ts';
import { WorkerStore } from './worker-store.mjs';
import { newId } from './ids.mjs';
import {
  resolveDelegationConfig as resolveDelegationConfigFromEnv,
  DEFAULT_DELEGATION,
  isDelegationEnabled,
  capabilityError,
  MAX_BUDGETS,
} from './runtime-config.mjs';

export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_MAX_COUNT = 50;
export const ARTIFACT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Live-streaming bounds: a bridge that floods stdout is killed, never buffered
// without limit. Progress must be visible while the child is still alive.
export const BRIDGE_LINE_CAP_CHARS = 256 * 1024;
export const BRIDGE_STDOUT_CAP_BYTES = 8 * 1024 * 1024;
export const BRIDGE_EVENT_CAP = 2000;
const EVENT_DETAIL_CAP = 2000;
const DIAG_CAP_BYTES = 1024 * 1024;

// Durable subtask delegation (H6): bounded fd-3 JSONL RPC. The main stdin
// request stays a single JSON object read to EOF (runtime-bridge-v1
// compatible); delegation uses an extra duplex pipe, never stdin.
export const TASK_RPC_VERSION = 'task-rpc-v1';
export const TASK_RPC_FD_ENV = 'ME_HOME_TASK_RPC_FD';
export const RPC_MAX_LINE_BYTES = 64 * 1024;
export const RPC_MAX_BUFFERED_BYTES = 512 * 1024;
export const RPC_MAX_REQUESTS_PER_RUN = 200;
export const DELEGATION_KEY_MAX_CHARS = 128;

export const TERMINAL_CHILD_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
export function isChildTerminal(status) {
  return TERMINAL_CHILD_STATUSES.has(status);
}

// Single durable authority for home tasks: the reused upstream TaskWorker owns
// every status transition (claim/lease/settle). The API layer below only
// moves tasks between states with compare-and-swap; it never writes status
// directly. Task execution itself happens in the R1 runtime bridge subprocess
// (runtime-bridge-v1): the home builds the trusted request, the bridge does
// the run, and the home persists parsed events/results/artifacts.
export function createTaskBroker({
  db,
  installationId,
  tasksRoot,
  runtime,
  runtimeError,
  model,
  modelError,
  capabilities,
  pollMs = 1000,
  termination = {},
  delegation,
  notifications = null,
  env = process.env,
}) {
  const store = new WorkerStore(db);
  const bootId = randomUUID();
  const children = new Map();
  // Bounded supervision (H5): every wait on a child has a deadline. SIGTERM
  // first, then SIGKILL, then give up waiting (the OS reaps the orphan).
  const term = {
    termGraceMs: numEnv(termination.termGraceMs ?? process.env.HOME_RUNTIME_TERM_GRACE_MS, 3000),
    killGraceMs: numEnv(termination.killGraceMs ?? process.env.HOME_RUNTIME_KILL_GRACE_MS, 3000),
    wallAllowanceMs: numEnv(termination.wallAllowanceMs ?? process.env.HOME_RUNTIME_WALL_ALLOWANCE_MS, 30000),
    shutdownMs: numEnv(termination.shutdownMs ?? process.env.HOME_SHUTDOWN_MS, 15000),
  };
  // Fail-closed: invalid HOME_DELEGATION_* throws here and refuses start
  // rather than falling open to widened defaults. Explicit overrides
  // (tests) bypass env parsing.
  const delegationConfig = delegation ?? resolveDelegationConfigFromEnv(env);
  // Single-authority serialization for delegation allocation: Node runs one
  // event loop, but submitChild awaits between read and write, so concurrent
  // same-key RPCs would both miss-then-insert. Chain allocation through one
  // promise mutex plus a SQLite IMMEDIATE transaction (see submitChildTask).
  let delegationChain = Promise.resolve();
  const withDelegationLock = (fn) => {
    const run = delegationChain.then(fn, fn);
    // Keep the chain alive across rejections; the caller still sees its own.
    delegationChain = run.catch(() => {});
    return run;
  };
  // The task workspace root holds per-run Phase input/output; keep it private.
  mkdirSync(tasksRoot, { recursive: true, mode: 0o700 });
  try {
    chmodSync(tasksRoot, 0o700);
  } catch {
    /* best effort on unfamiliar filesystems */
  }
  const broker = {
    store,
    bootId,
    children,
    tasksRoot,
    runtime,
    runtimeError: runtimeError ?? null,
    model,
    modelError,
    capabilities,
    termination: term,
    delegation: delegationConfig,
    notifications: notifications ?? null,
    _withDelegationLock: withDelegationLock,
  };
  // Link the notification outbox back to this broker's store for stale-state
  // revalidation at send time (answered/revoked alerts drop). The link is
  // assigned, never copied: restarts keep the same service object.
  if (broker.notifications) {
    try { broker.notifications.store = store; } catch { /* best effort */ }
  }

  const worker = new TaskWorker(store, (owner, task, context) => runBridge(broker, owner, task, context), {
    pollMs,
    settled: (owner, task) => {
      void handleSettled(broker, owner, task).catch((error) =>
        console.error(`[tasks] settled hook failed: ${error?.message ?? error}`),
      );
    },
  });
  broker.worker = worker;

  broker.start = async () => {
    await recoverInterrupted(store, bootId);
    await reconcileWaitingParents(broker);
    worker.start();
    // Restart resumes pending notifications: the outbox is crash-durable, so
    // a pump on boot redelivers anything queued before the restart (dedupe by
    // stable event ID keeps it at-least-once, never duplicated on the phone).
    if (broker.notifications) {
      try { await broker.notifications.pump(); } catch (error) {
        console.error(`[notifications] boot pump failed: ${error?.message ?? error}`);
      }
      try { broker.notifications.start?.(); } catch { /* best effort */ }
    }
  };
  broker.stop = async () => {
    // Bounded shutdown: abort handlers (their child waits escalate TERM then
    // KILL with deadlines), then terminate any leftovers the same way. Never
    // wait forever — S2's graceful-SIGTERM hang came from an unbounded wait.
    const wedged = await withDeadline(worker.stop(), term.shutdownMs);
    if (wedged.timedOut) {
      console.error('[tasks] worker.stop exceeded shutdown deadline; continuing shutdown');
    }
    const deadline = Date.now() + term.shutdownMs;
    for (const [id, child] of [...children]) {
      const remaining = Math.max(0, deadline - Date.now());
      await terminateChild(child, { ...term, shutdownMs: remaining });
      children.delete(id);
    }
    children.clear();
    // Bounded stop: cancel the delivery timer; in-flight sends are bounded by
    // their own timeouts and never wedge shutdown.
    try { await broker.notifications?.stop?.(); } catch { /* best effort */ }
  };
  broker.kick = () => {
    void worker.tick().catch((error) => console.error(`[tasks] tick failed: ${error?.message ?? error}`));
  };

  broker.submit = async ({ owner, conversation, title, request, reqCaps, budgets }) =>
    submitTask(broker, { owner, conversation, title, request, reqCaps, budgets });
  broker.submitChild = async (owner, parentId, params, opts) => submitChildTask(broker, owner, parentId, params, opts ?? {});
  broker.answer = async (owner, taskId, inputs) => answerTask(broker, owner, taskId, inputs);
  broker.decide = async (owner, taskId, approvals) => decideApprovals(broker, owner, taskId, approvals);
  broker.cancel = async (owner, taskId) => cancelTask(broker, owner, taskId);
  broker.taskView = async (owner, taskId, { withProgress = true } = {}) =>
    taskView(broker, owner, taskId, { withProgress });
  broker.listViews = async (owner, conversationId) => {
    const conv = db
      .prepare('SELECT id, owner_id FROM conversations WHERE id = ?')
      .get(conversationId);
    if (!conv || conv.owner_id !== owner) return null;
    const all = [];
    for (const { owner: rowOwner, value } of await store.scan('tasks')) {
      if (rowOwner === owner && value?.input?.conversationId === conversationId) {
        all.push(value);
      }
    }
    const byParent = new Map();
    for (const t of all) {
      const pid = t.parentTaskId ?? null;
      if (pid) {
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(t.id);
      }
    }
    const views = all.map((t) => summarize(t, byParent.get(t.id) ?? []));
    views.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
    return views;
  };
  broker.artifactList = async (owner, taskId) => {
    const task = await store.get(owner, 'tasks', taskId);
    if (!task) return null;
    return db
      .prepare('SELECT id, name, sha256, size, created_at FROM artifacts WHERE owner_id = ? AND task_id = ? ORDER BY created_at, id')
      .all(owner, taskId);
  };
  broker.artifactContent = async (owner, artifactId) => {
    const row = db
      .prepare('SELECT id, owner_id, task_id, name, bytes, sha256, size FROM artifacts WHERE id = ?')
      .get(artifactId);
    if (!row || row.owner_id !== owner) return null;
    return row;
  };
  return broker;
}

function sansBoot(state) {
  if (!state || typeof state !== 'object') return {};
  const next = { ...state };
  delete next.bootId;
  return next;
}

function numEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid supervision timeout: ${raw}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Race a promise against a deadline. Always resolves; clears its timer.
export async function withDeadline(promise, ms) {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
    });
    const result = await Promise.race([promise.then(() => ({ timedOut: false })), timeout]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// Bounded child termination: SIGTERM, then SIGKILL after termGraceMs, then
// give up waiting after killGraceMs (the OS reaps the orphan). Always
// resolves and clears every timer/listener it creates.
export async function terminateChild(child, { termGraceMs = 3000, killGraceMs = 3000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { outcome: 'already' };
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve(true));
  });
  try {
    child.kill('SIGTERM');
  } catch {
    return { outcome: 'already' };
  }
  if (!(await withDeadline(exited, termGraceMs)).timedOut) return { outcome: 'term' };
  if (child.exitCode !== null || child.signalCode !== null) return { outcome: 'term' };
  try {
    child.kill('SIGKILL');
  } catch {
    return { outcome: 'already' };
  }
  if (!(await withDeadline(exited, killGraceMs)).timedOut) return { outcome: 'kill' };
  try {
    child.unref?.();
  } catch {
    /* best effort */
  }
  return { outcome: 'timeout' };
}

// Home restart recovery: no child process survives a restart, so anything the
// previous boot had claimed (running, or queued-but-previously-claimed) holds
// an orphaned lease with uncertain external effects. Mark it interrupted
// instead of blindly replaying it, and remove any assistant message it may
// have published before its settle checkpoint landed. Waiting tasks keep their
// inbox state and resume explicitly via answer/approve; waiting_children
// parents survive and reconcile via tryWakeParent without replaying completed
// external actions. Already-succeeded tasks missing their assistant message
// (e.g. settled before H3) are backfilled idempotently.
async function recoverInterrupted(store, bootId) {
  const db = store.db;
  for (const { owner, value } of await store.scan('tasks')) {
    if (value.status === 'running') {
      deleteAssistantMessages(db, value.id);
      await store.compareAndSwap(
        owner,
        'tasks',
        value.id,
        { status: 'running' },
        {
          status: 'failed',
          error: 'Home restarted during this run; not retried (external effects uncertain)',
          leaseId: null,
          leaseUntil: null,
          updatedAt: new Date().toISOString(),
        },
      );
    } else if (value.status === 'queued' && value?.state?.bootId && value.state.bootId !== bootId) {
      deleteAssistantMessages(db, value.id);
      await store.compareAndSwap(
        owner,
        'tasks',
        value.id,
        { status: 'queued' },
        {
          status: 'failed',
          error: 'Home restarted after this run started; not retried (external effects uncertain)',
          leaseId: null,
          leaseUntil: null,
          state: sansBoot(value.state),
          updatedAt: new Date().toISOString(),
        },
      );
    } else if (value.status === 'succeeded' && value.result) {
      // Roots publish; delegated children stay private (aggregated by parent).
      if (value.parentTaskId) continue;
      const convId = value?.input?.conversationId;
      const existing = db
        .prepare('SELECT id FROM messages WHERE task_id = ? AND role = ?')
        .get(value.id, 'assistant');
      if (!existing && convId) {
        const conv = db.prepare('SELECT owner_id FROM conversations WHERE id = ?').get(convId);
        if (conv && conv.owner_id === owner) {
          publishAssistantMessage(db, owner, convId, value.id, value.result);
        }
      }
    }
  }
}

async function submitTask(broker, { owner, conversation, title, request, reqCaps, budgets }) {
  const { clampCapabilities, clampBudgets } = await import('./runtime-config.mjs');
  if (broker.modelError || !broker.model) {
    throw Object.assign(new Error(broker.modelError ?? 'No model configured'), {
      code: 'model_not_configured',
    });
  }
  if (broker.runtimeError) {
    throw Object.assign(new Error(broker.runtimeError), { code: 'runtime_not_configured' });
  }
  const capabilities = clampCapabilities(reqCaps, broker.capabilities);
  const clampedBudgets = clampBudgets(budgets);
  if (typeof request !== 'string' || !request.trim() || request.length > 8000) {
    throw Object.assign(new Error('request must be non-empty text up to 8000 chars'), { code: 'bad_request' });
  }
  const cleanTitle = String(title ?? 'Untitled task').slice(0, 200) || 'Untitled task';
  const id = newId('task');
  const workspace = join(broker.tasksRoot, id);
  mkdirSync(join(workspace, 'input'), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const task = {
    id,
    title: cleanTitle,
    prompt: request,
    kind: 'agent',
    status: 'queued',
    plan: [],
    evidence: [],
    parentTaskId: null,
    rootTaskId: id,
    delegationKey: null,
    delegationHash: null,
    depth: 0,
    childIds: [],
    input: {
      conversationId: conversation.id,
      runId: id,
      request,
      capabilities,
      budgets: clampedBudgets,
      model: broker.model,
    },
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
  await broker.store.put(owner, 'tasks', task);
  broker.kick();
  return task;
}

function delegationPayloadHash({ request, capabilities, budgets, title }) {
  const stable = JSON.stringify({
    request,
    capabilities: capabilities ?? null,
    budgets: budgets ?? null,
    title: title ?? null,
  });
  return createHash('sha256').update(stable, 'utf8').digest('hex');
}

function clampChildCapabilities(requested, parentCaps, hostPolicy) {
  // Strict booleans validated against the parent ceiling (which is already a
  // subset of the host ceiling). Widening beyond the parent is denied; the
  // host policy is re-checked so a corrupted parent record cannot escalate.
  // Shares error codes with the shared clampCapabilities validator.
  const req = requested === undefined || requested === null ? {} : requested;
  if (typeof req !== 'object' || Array.isArray(req)) {
    throw capabilityError('capabilities must be an object');
  }
  const allowedKeys = ['files', 'web_fetch', 'browser', 'code_exec', 'animation'];
  for (const key of Object.keys(req)) {
    if (key !== 'network_egress_allowlist' && !allowedKeys.includes(key)) {
      throw capabilityError(`Unknown capability: ${key}`);
    }
  }
  const out = { network_egress_allowlist: [] };
  for (const key of allowedKeys) {
    const value = req[key] ?? parentCaps?.[key] ?? (key === 'files');
    if (typeof value !== 'boolean') {
      throw capabilityError(`Capability ${key} must be a boolean`);
    }
    if (value === true && parentCaps?.[key] !== true) {
      throw capabilityError(`Capability not granted to parent: ${key}`);
    }
    if (value === true && hostPolicy?.[key] !== true) {
      throw capabilityError(`Capability not enabled on this home: ${key}`);
    }
    out[key] = value;
  }
  const allowlist = req.network_egress_allowlist ?? parentCaps?.network_egress_allowlist ?? [];
  if (!Array.isArray(allowlist) || allowlist.some((h) => typeof h !== 'string' || h.length === 0)) {
    throw capabilityError('network_egress_allowlist must be an array of non-empty strings');
  }
  for (const host of allowlist) {
    if (!parentCaps?.network_egress_allowlist?.includes(host)) {
      throw capabilityError(`Egress host not granted to parent: ${host}`);
    }
    if (!hostPolicy?.network_egress_allowlist?.includes(host)) {
      throw capabilityError(`Egress host not allowlisted on this home: ${host}`);
    }
  }
  out.network_egress_allowlist = allowlist;
  return out;
}

function clampChildBudgets(requested, parentBudgets) {
  const allowed = ['max_steps', 'max_wall_seconds', 'max_tool_calls'];
  const req = requested === undefined || requested === null ? {} : requested;
  if (typeof req !== 'object' || Array.isArray(req)) {
    throw Object.assign(new Error('budgets must be an object'), { code: 'bad_request' });
  }
  for (const key of Object.keys(req)) {
    if (!allowed.includes(key)) {
      throw Object.assign(new Error(`Unknown budget: ${key}`), { code: 'bad_request' });
    }
  }
  const out = {};
  for (const key of allowed) {
    const parentVal = parentBudgets?.[key];
    const value = req[key] ?? parentVal;
    if (!Number.isInteger(value) || value < 1) {
      throw Object.assign(new Error(`${key} must be a positive integer`), { code: 'bad_request' });
    }
    if (Number.isInteger(parentVal) && value > parentVal) {
      throw Object.assign(new Error(`${key} exceeds parent budget (${parentVal})`), { code: 'bad_request' });
    }
    out[key] = value;
  }
  // Global maxima still apply (defense in depth if the parent record predates them).
  for (const key of allowed) {
    if (out[key] > MAX_BUDGETS[key]) {
      throw Object.assign(new Error(`${key} exceeds home maximum`), { code: 'bad_request' });
    }
  }
  return out;
}

async function directChildren(broker, owner, parentId) {
  const out = [];
  for (const { owner: rowOwner, value } of await broker.store.scan('tasks')) {
    if (rowOwner === owner && value?.parentTaskId === parentId) out.push(value);
  }
  return out;
}

async function rootTaskCount(broker, owner, rootId) {
  let n = 0;
  for (const { owner: rowOwner, value } of await broker.store.scan('tasks')) {
    if (rowOwner !== owner) continue;
    if (value?.id === rootId || value?.rootTaskId === rootId) n += 1;
  }
  return n;
}

// Authoritative child spawn: owner/conversation/model inherited from the
// parent closure, never from RPC params. Idempotent on (parent,key) with a
// hash over request/caps/budgets/title: same hash returns the existing child,
// different hash is a 409 conflict. No second job engine — the child is a
// normal task record owned by the reused TaskWorker.
async function submitChildTask(broker, owner, parentId, params, opts = {}) {
  const delegation = broker.delegation ?? DEFAULT_DELEGATION;
  if (!isDelegationEnabled(delegation)) {
    throw Object.assign(new Error('Subtask delegation is disabled on this home'), { code: 'delegation_denied' });
  }
  // Serialize allocation through the single-authority mutex so concurrent
  // same-key RPCs cannot both miss-then-insert. The SQLite IMMEDIATE
  // transaction inside re-validates parent status/lease, idempotency,
  // fanout, and root-count atomically.
  const lock = broker._withDelegationLock ?? ((fn) => fn());
  return lock(() => allocateChildTask(broker, owner, parentId, params, opts));
}

async function allocateChildTask(broker, owner, parentId, params, opts = {}) {
  const delegation = broker.delegation ?? DEFAULT_DELEGATION;
  const parentBefore = await broker.store.get(owner, 'tasks', parentId);
  if (!parentBefore) {
    throw Object.assign(new Error('Parent task not found'), { code: 'not_found' });
  }
  if (parentBefore.status !== 'running') {
    throw Object.assign(new Error(`Parent is ${parentBefore.status}, not running`), { code: 'wrong_state' });
  }
  const rawKey = params?.key;
  if (typeof rawKey !== 'string' || !rawKey.trim() || rawKey.length > DELEGATION_KEY_MAX_CHARS) {
    throw Object.assign(new Error(`key must be 1..${DELEGATION_KEY_MAX_CHARS} chars`), { code: 'bad_request' });
  }
  const key = rawKey.trim();
  const request = params?.request;
  if (typeof request !== 'string' || !request.trim() || request.length > 8000) {
    throw Object.assign(new Error('request must be non-empty text up to 8000 chars'), { code: 'bad_request' });
  }
  const title = String(params?.title ?? 'Subtask').slice(0, 200) || 'Subtask';
  const parentCaps = parentBefore.input?.capabilities ?? { files: true, network_egress_allowlist: [] };
  const parentBudgets = parentBefore.input?.budgets ?? { max_steps: 8, max_wall_seconds: 120, max_tool_calls: 20 };
  const capabilities = clampChildCapabilities(params?.capabilities, parentCaps, broker.capabilities);
  const budgets = clampChildBudgets(params?.budgets, parentBudgets);
  const depth = (parentBefore.depth ?? 0) + 1;
  if (depth > delegation.maxDepth) {
    throw Object.assign(new Error(`Delegation depth ${depth} exceeds home maximum ${delegation.maxDepth}`), {
      code: 'delegation_denied',
    });
  }
  // Cross-owner/cross-conversation links are impossible by construction:
  // owner comes from the spawning closure and conversation/model inherit.
  const conversationId = parentBefore.input?.conversationId;
  if (!conversationId) {
    throw Object.assign(new Error('Parent has no conversation'), { code: 'bad_request' });
  }
  const rootId = parentBefore.rootTaskId ?? parentBefore.id;
  const hash = delegationPayloadHash({ request, capabilities, budgets, title });
  const id = newId('task');
  const workspace = join(broker.tasksRoot, id);
  mkdirSync(join(workspace, 'input'), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const child = {
    id,
    title,
    prompt: request,
    kind: 'agent',
    status: 'queued',
    plan: [],
    evidence: [],
    parentTaskId: parentId,
    rootTaskId: rootId,
    delegationKey: key,
    delegationHash: hash,
    depth,
    childIds: [],
    input: {
      conversationId,
      runId: id,
      request,
      capabilities,
      budgets,
      model: parentBefore.input?.model ?? broker.model,
    },
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
  // Atomic durable allocation: re-validate parent status/lease, idempotency,
  // fanout, and root-count inside one SQLite IMMEDIATE transaction. The
  // outer mutex serializes concurrent allocators; the transaction guards
  // against cancellation interleavings and cross-restart duplicates.
  const db = broker.store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?')
      .get(owner, 'tasks', parentId);
    const parent = row ? JSON.parse(row.data) : null;
    if (!parent) {
      throw Object.assign(new Error('Parent task not found'), { code: 'not_found' });
    }
    if (parent.status !== 'running') {
      throw Object.assign(new Error(`Parent is ${parent.status}, not running`), { code: 'wrong_state' });
    }
    if (opts.expectedLeaseId !== undefined && parent.leaseId !== opts.expectedLeaseId) {
      throw Object.assign(new Error('Parent lease changed; stale runtime denied'), { code: 'wrong_state' });
    }
    if (opts.aborted?.()) {
      throw Object.assign(new Error('Parent run was cancelled'), { code: 'wrong_state' });
    }
    const sibRows = db
      .prepare("SELECT data FROM records WHERE owner = ? AND kind = 'tasks'")
      .all(owner)
      .map((r) => JSON.parse(r.data));
    const siblings = sibRows.filter((t) => t?.parentTaskId === parentId);
    const existing = siblings.find((t) => t.delegationKey === key);
    if (existing) {
      if (existing.delegationHash === hash) {
        db.exec('ROLLBACK');
        return existing;
      }
      throw Object.assign(new Error('delegation key already used with a different payload'), {
        code: 'delegation_conflict',
      });
    }
    if (siblings.length >= delegation.maxFanout) {
      throw Object.assign(new Error(`Parent already has ${siblings.length} children (max ${delegation.maxFanout})`), {
        code: 'delegation_denied',
      });
    }
    let total = 0;
    for (const t of sibRows) {
      if (t?.id === rootId || t?.rootTaskId === rootId) total += 1;
    }
    if (total >= delegation.maxTasksPerRoot) {
      throw Object.assign(new Error(`Task tree already has ${total} tasks (max ${delegation.maxTasksPerRoot})`), {
        code: 'delegation_denied',
      });
    }
    // Depth re-check against the fresh parent record (not the pre-lock copy).
    const freshDepth = (parent.depth ?? 0) + 1;
    if (freshDepth > delegation.maxDepth) {
      throw Object.assign(new Error(`Delegation depth ${freshDepth} exceeds home maximum ${delegation.maxDepth}`), {
        code: 'delegation_denied',
      });
    }
    child.depth = freshDepth;
    db.prepare(
      'INSERT INTO records(owner, kind, id, data, updated_at) VALUES(?, ?, ?, ?, ?)',
    ).run(owner, 'tasks', child.id, JSON.stringify(child), Date.now());
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
  broker.kick();
  return child;
}

function validRpcId(id) {
  if (typeof id === 'string') return id.length >= 1 && id.length <= 128;
  return Number.isSafeInteger(id);
}

async function checkRpcLease(broker, owner, parentId, rpcCtx = {}) {
  if (rpcCtx.aborted?.()) {
    throw Object.assign(new Error('Parent run was cancelled'), { code: 'wrong_state' });
  }
  const parent = await broker.store.get(owner, 'tasks', parentId);
  if (!parent) throw Object.assign(new Error('Parent task not found'), { code: 'not_found' });
  if (parent.status !== 'running') {
    throw Object.assign(new Error(`Parent is ${parent.status}, not running`), { code: 'wrong_state' });
  }
  if (rpcCtx.expectedLeaseId !== undefined && parent.leaseId !== rpcCtx.expectedLeaseId) {
    throw Object.assign(new Error('Parent lease changed; stale runtime denied'), { code: 'wrong_state' });
  }
  return parent;
}

async function handleTaskRpc(broker, owner, parentId, method, params, rpcCtx = {}) {
  if (method === 'submit_child') {
    await checkRpcLease(broker, owner, parentId, rpcCtx);
    const child = await submitChildTask(broker, owner, parentId, params ?? {}, {
      expectedLeaseId: rpcCtx.expectedLeaseId,
      aborted: rpcCtx.aborted,
    });
    return { child: summarize(child) };
  }
  if (method === 'list_children') {
    await checkRpcLease(broker, owner, parentId, rpcCtx);
    const kids = await directChildren(broker, owner, parentId);
    kids.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return { children: kids.map((t) => summarize(t)) };
  }
  if (method === 'get_child') {
    await checkRpcLease(broker, owner, parentId, rpcCtx);
    const id = params?.id;
    if (typeof id !== 'string' || !id) {
      throw Object.assign(new Error('id is required'), { code: 'bad_request' });
    }
    const child = await broker.store.get(owner, 'tasks', id);
    // Owner+parent binding from the closure: arbitrary global lookup is
    // never allowed — the id must be a direct child of this parent.
    if (!child || child.parentTaskId !== parentId) {
      throw Object.assign(new Error('Child not found'), { code: 'not_found' });
    }
    return { child: summarize(child) };
  }
  throw Object.assign(new Error('Unknown rpc method'), { code: 'bad_request' });
}

// Duplex JSONL RPC over the owned fd pipe. Owner/parent/lease bind from the
// spawning closure; request user IDs are never trusted. Never logs request
// contents or credentials; errors carry only code + short message.
export const RPC_MAX_RESPONSE_BYTES = 128 * 1024;
export const RPC_MAX_METHOD_CHARS = 64;
export const RPC_MAX_PARAMS_BYTES = 32 * 1024;
export const RPC_MAX_PENDING_WRITE_BYTES = 256 * 1024;

// Trusted runtime environment builder (H7.1). The bridge child previously
// inherited the whole host env, which would hand the LLM runtime (and any
// generated/browser code) host secrets such as HOME_EXPO_ACCESS_TOKEN, SSH
// agents, cloud credentials, or tunnel tokens. The builder passes only:
//  - functional locale/path/temp/cert/proxy plumbing,
//  - the runtime's own ME_RUNTIME_* execution/model opts,
//  - ONLY the trusted model.api_key_env value named by the home-selected
//    model config (validated as a plain env name),
//  - the fd-3 task-RPC binding.
// Everything else (HOME_*, SSH_*, AWS_*, tunnel/admin keys, notification
// secrets) never crosses into the runtime. This is secret exclusion, not a
// sandbox claim: ME_RUNTIME_* execution opts pass through (the runtime's own
// config namespace), secret-looking ME_RUNTIME_* names cross ONLY as the
// trusted model.api_key_env value, and PATH/proxy stay functional.
export const RUNTIME_FUNCTIONAL_ENV_KEYS = [
  'PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LANGUAGE',
  'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'ALL_PROXY', 'all_proxy', 'VIRTUAL_ENV', 'SystemRoot', 'WINDIR',
];
const RUNTIME_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{1,127}$/;
export function buildRuntimeEnv(sourceEnv = process.env, model = null) {
  const out = {};
  for (const key of RUNTIME_FUNCTIONAL_ENV_KEYS) {
    const value = sourceEnv?.[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  // The runtime's own ME_RUNTIME_* execution/model opts pass through, EXCEPT
  // secret-looking names: a key/callback credential crosses ONLY when it is
  // the trusted model.api_key_env value named by the home-selected model.
  const apiKeyName = typeof model?.api_key_env === 'string' && RUNTIME_ENV_NAME_RE.test(model.api_key_env)
    ? model.api_key_env
    : null;
  const looksSecret = (key) => /API_KEY|SECRET|TOKEN|PRIVATE|PASSWORD|CREDENTIAL/i.test(key);
  if (sourceEnv && typeof sourceEnv === 'object') {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!key.startsWith('ME_RUNTIME_') || !RUNTIME_ENV_NAME_RE.test(key)) continue;
      if (looksSecret(key) && key !== apiKeyName) continue;
      out[key] = value;
    }
  }
  if (apiKeyName) {
    const value = sourceEnv?.[apiKeyName];
    if (typeof value === 'string' && value.length > 0) out[apiKeyName] = value;
  }
  // Defense in depth: host push/admin/coordinator secrets never cross, even
  // if a future functional key collides with these prefixes. H8: the
  // coordinator credentials file reference (HOME_COORDINATOR_*) and any
  // cloud/home token material stay on the home host, never in runtime env.
  for (const key of Object.keys(out)) {
    if (key.startsWith('ME_RUNTIME_')) continue;
    if (
      key.startsWith('HOME_EXPO_') || key.startsWith('HOME_NOTIFICATIONS_') ||
      key.startsWith('HOME_NOTIF_') || key.startsWith('HOME_COORDINATOR_') ||
      key.startsWith('SSH_') || key.startsWith('AWS_') ||
      key.startsWith('TUNNEL_') || key.startsWith('CLOUDFLARE_') || key.startsWith('TAILSCALE_') ||
      key.startsWith('NGROK_')
    ) {
      delete out[key];
    }
  }
  out[TASK_RPC_FD_ENV] = '3';
  return out;
}
export function startTaskRpc(broker, owner, parentId, socket, rpcCtx = {}) {
  let closed = false;
  let buffered = '';
  let bufferedBytes = 0;
  let count = 0;
  const decoder = new StringDecoder('utf8');
  const send = (id, ok, payload) => {
    if (closed) return;
    try {
      if (!validRpcId(id)) return;
      const msg = ok
        ? { rpc: TASK_RPC_VERSION, id, ok: true, result: payload }
        : { rpc: TASK_RPC_VERSION, id, ok: false, error: payload };
      const line = `${JSON.stringify(msg)}\n`;
      if (Buffer.byteLength(line, 'utf8') > RPC_MAX_RESPONSE_BYTES) {
        const tiny = JSON.stringify({ rpc: TASK_RPC_VERSION, id, ok: false, error: { code: 'bad_request', message: 'response too large' } }) + '\n';
        try {
          if ((socket.writableLength ?? 0) > RPC_MAX_PENDING_WRITE_BYTES) { try { socket.destroy(); } catch {} closed = true; return; }
          socket.write(tiny);
        } catch { /* bounded: drop on write failure */ }
        return;
      }
      try {
        if ((socket.writableLength ?? 0) > RPC_MAX_PENDING_WRITE_BYTES) { try { socket.destroy(); } catch {} closed = true; return; }
        const accepted = socket.write(line);
        if (!accepted && (socket.writableLength ?? 0) > RPC_MAX_PENDING_WRITE_BYTES) { try { socket.destroy(); } catch {} closed = true; }
      } catch { /* bounded: drop on write failure */ }
    } catch { /* bounded: drop on write failure */ }
  };
  const terminateBudget = (id) => {
    // Request budget exhausted: one honest error for the triggering request,
    // then close the pipe so a runaway runtime cannot wedge the home.
    if (id !== null && id !== undefined) {
      send(id, false, { code: 'delegation_denied', message: 'rpc request budget exceeded' });
    }
    closed = true;
    try { socket.removeListener('data', onData); } catch { /* already gone */ }
    try { socket.destroy(); } catch { /* already gone */ }
  };
  const onData = (chunk) => {
    if (closed) return;
    let text;
    try {
      text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    } catch {
      return;
    }
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (bufferedBytes + textBytes > RPC_MAX_BUFFERED_BYTES) {
      // Flooded without newlines: drop the buffer and close the pipe.
      buffered = '';
      bufferedBytes = 0;
      closed = true;
      try { socket.destroy(); } catch { /* already gone */ }
      return;
    }
    buffered += text;
    bufferedBytes += textBytes;
    let idx;
    while ((idx = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 1);
      bufferedBytes = Buffer.byteLength(buffered, 'utf8');
      if (closed) return;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > RPC_MAX_LINE_BYTES) {
        // Best-effort id extraction for correlation (the full line is not
        // JSON-parseable at this size); regex only, never evaluated.
        let id = null;
        try {
          const m = line.slice(0, 4096).match(/"id"\s*:\s*("[^"]{1,128}"|-?\d{1,15})/);
          if (m) id = JSON.parse(m[1]);
        } catch { /* unparseable */ }
        if (id !== null && id !== undefined && validRpcId(id)) {
          send(id, false, { code: 'bad_request', message: 'rpc line exceeds 64 KiB' });
        }
        continue;
      }
      count += 1;
      if (count > RPC_MAX_REQUESTS_PER_RUN) {
        let id = null;
        try { id = JSON.parse(line)?.id ?? null; } catch { /* ignore */ }
        terminateBudget(id);
        return;
      }
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      if (!req || req.rpc !== TASK_RPC_VERSION || !validRpcId(req.id) || typeof req.method !== 'string' || req.method.length > RPC_MAX_METHOD_CHARS) {
        if (req && validRpcId(req?.id)) send(req.id, false, { code: 'bad_request', message: 'invalid rpc envelope' });
        continue;
      }
      const { id, method, params } = req;
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        send(id, false, { code: 'bad_request', message: 'params must be an object' });
        continue;
      }
      try {
        if (Buffer.byteLength(JSON.stringify(params ?? {}), 'utf8') > RPC_MAX_PARAMS_BYTES) {
          send(id, false, { code: 'bad_request', message: 'params too large' });
          continue;
        }
      } catch {
        send(id, false, { code: 'bad_request', message: 'params too large' });
        continue;
      }
      void handleTaskRpc(broker, owner, parentId, method, params ?? {}, rpcCtx)
        .then((result) => send(id, true, result))
        .catch((error) => send(id, false, { code: error?.code ?? 'bad_request', message: String(error?.message ?? 'rpc failed').slice(0, 200) }));
    }
  };
  socket.on('data', onData);
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.removeListener('data', onData); } catch { /* already gone */ }
    try { socket.destroy(); } catch { /* already gone */ }
  };
  socket.once('close', () => { closed = true; });
  socket.once('error', () => { /* bounded: no throw from event emitter */ });
  return { close };
}

async function runBridge(broker, owner, task, context) {
  const input = task.input ?? {};
  const resume = input.resume ?? null;
  // Consume the resume payload and stamp this boot before spawning anything,
  // so a restart can distinguish claimed runs from fresh queue entries.
  const cleanInput = { ...input };
  delete cleanInput.resume;
  await context.checkpoint({
    input: cleanInput,
    state: { ...(task.state ?? {}), bootId: broker.bootId },
  });
  if (!resume && (task.state?.lastTerminal === 'awaiting_approval' || task.state?.lastTerminal === 'waiting_input')) {
    // Eligible again without fresh inbox decisions (e.g. an expiry path):
    // never re-execute blindly.
    return {
      status: 'failed',
      error: `Run resumed without fresh inbox decisions after ${task.state.lastTerminal}; not re-executed`,
    };
  }
  // The bridge owns its persisted run state (R2: harness checkpoint plus a
  // pending record); the home never inspects runtime-private filenames. op is
  // resume exactly when the inbox supplied fresh decisions, and a bridge
  // rejection of a stale resume fails the task honestly.
  const workspace = join(broker.tasksRoot, task.id);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const op = resume ? 'resume' : 'run';
  const contextRefs = conversationContext(broker, owner, input.conversationId);
  const bridgeRequest = {
    bridge: 'runtime-bridge-v1',
    op,
    run_id: task.id,
    user_id: owner,
    conversation_id: input.conversationId,
    workspace,
    ...(op === 'run' ? { request: task.prompt } : {}),
    ...(resume?.inputs ? { inputs: resume.inputs } : {}),
    ...(resume?.approvals ? { approvals: resume.approvals } : {}),
    ...(resume?.childResults ? { child_results: resume.childResults } : {}),
    capabilities: cleanInput.capabilities,
    model: cleanInput.model,
    budgets: cleanInput.budgets,
    context_refs: contextRefs,
  };
  // fd-3 duplex RPC (task-rpc-v1): main stdin stays a single JSON object read
  // to EOF for runtime-bridge-v1 compatibility; delegation uses the extra
  // pipe with ME_HOME_TASK_RPC_FD=3. Legacy bridges that never open fd 3 are
  // unaffected (the home simply sees no RPC requests before child exit).
  const child = spawn(broker.runtime.command[0], broker.runtime.command.slice(1), {
    cwd: broker.runtime.cwd,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    shell: false,
    // Curated env only (H7.1): host push/admin secrets never reach the LLM
    // runtime. The model key travels solely via the trusted model config.
    env: buildRuntimeEnv(process.env, cleanInput.model),
  });
  broker.children.set(task.id, child);
  // Lease binding: the fd-3 RPC is only valid for the lease that spawned it.
  // If the worker re-claims the task under a new lease (takeover), the old
  // bridge's spawns/reads are denied inside the allocation transaction.
  const rpcLeaseId = task.leaseId ?? null;
  let rpc = null;
  try {
    const rpcSocket = child.stdio?.[3];
    if (rpcSocket) {
      rpc = startTaskRpc(broker, owner, task.id, rpcSocket, {
        expectedLeaseId: rpcLeaseId,
        aborted: () => context.signal.aborted,
      });
    }
  } catch {
    rpc = null;
  }
  // Bounded abort: SIGTERM, escalate to SIGKILL, then stop waiting. The close
  // wait below therefore always resolves — shutdown can never hang on a child
  // that ignores SIGTERM.
  let aborting = false;
  const boundedAbort = () => {
    if (aborting) return;
    aborting = true;
    void terminateChild(child, broker.termination).catch(() => {});
  };
  if (context.signal.aborted) boundedAbort();
  else context.signal.addEventListener('abort', boundedAbort, { once: true });
  // Stdin failures (e.g. EPIPE after a kill) surface here; an undelivered
  // request means the child cannot produce a valid run, which the no-result
  // path below reports honestly.
  let stdinError = null;
  child.stdin.on('error', (error) => {
    stdinError = stdinError ?? error;
  });
  // Home-side wall backstop: budgets belong to the runtime, but a runtime that
  // ignores them must not run forever. Fires once; disarmed on close.
  const wallMs =
    (Number(cleanInput.budgets?.max_wall_seconds) || 120) * 1000 + broker.termination.wallAllowanceMs;
  let wallTimer;
  const disarmWall = () => clearTimeout(wallTimer);
  const diagPath = join(workspace, '.me_runtime', 'diagnostics.log');
  try {
    mkdirSync(join(workspace, '.me_runtime'), { recursive: true, mode: 0o700 });
  } catch { /* exists */ }
  child.stderr.on('data', (data) => {
    const line = String(data).slice(0, 500);
    try {
      if (!existsSync(diagPath) || statSync(diagPath).size < DIAG_CAP_BYTES) {
        appendFileSync(diagPath, line.endsWith('\n') ? line : `${line}\n`);
      }
    } catch {
      /* diagnostics are best effort */
    }
    process.stderr.write(`[runtime ${task.id.slice(0, 13)}] ${line.slice(0, 200)}\n`);
  });
  const events = createLiveBridgeStream(child, task.id, boundedAbort, async (obj) => {
    if (obj.event === 'progress') {
      await context.event('status', String(obj.message ?? 'progress').slice(0, 500));
    } else if (obj.event === 'started') {
      await context.event('status', 'Runtime started');
    } else if (obj.event === 'tool_call') {
      await context.event('status', `tool ${String(obj.tool ?? '?').slice(0, 80)}`, JSON.stringify(obj.args ?? {}).slice(0, EVENT_DETAIL_CAP));
    } else if (obj.event === 'tool_result') {
      await context.event('status', `tool result ${String(obj.tool ?? '?').slice(0, 80)}`, JSON.stringify(obj.result ?? { ok: obj.ok }).slice(0, EVENT_DETAIL_CAP));
    } else if (obj.event === 'artifact') {
      await context.event('result', `artifact ${String(obj.path ?? '?').slice(0, 200)}`);
    }
    // Unknown non-terminal events are ignored for forward compatibility.
  });
  wallTimer = setTimeout(() => {
    events.kill(new Error(`runtime exceeded its wall budget (${Math.round(wallMs / 1000)}s); child killed`));
  }, wallMs);
  if (wallTimer.unref) wallTimer.unref();
  const exit = await new Promise((resolving, rejecting) => {
    child.on('error', rejecting);
    child.on('close', (code, signal) => resolving({ code, signal }));
    try {
      child.stdin.write(JSON.stringify(bridgeRequest));
      child.stdin.end();
    } catch (error) {
      rejecting(error);
    }
  }).finally(() => {
    disarmWall();
    try { rpc?.close(); } catch { /* already closed */ }
    broker.children.delete(task.id);
  });
  await events.drained();
  try { rpc?.close(); } catch { /* already closed */ }
  // run()'s catch path owns lease semantics from here: a LostLeaseError (or a
  // status changed under us, e.g. cancel) reconciles without writing.
  if (events.violation) throw events.violation;
  if (!events.terminal) {
    const hint = stdinError ? ` stdin error: ${stdinError.message ?? stdinError}` : '';
    throw new Error(`bridge exited (code ${exit?.code}) without a result event.${hint}`);
  }
  return settleTerminal(broker, owner, task, events.terminal, workspace);
}

// Live bridge stdout handling (H3). Every line is validated and every
// progress event is persisted while the child runs — never buffered until
// exit. Each persist goes through context.event, whose guard refuses to write
// once the lease is lost, so cancelled/taken-over runs cannot append history.
// Malformed, mismatched, oversized, or flooded output kills the child and
// fails the task instead of being trusted.
function createLiveBridgeStream(child, taskId, abortChild, onProgressEvent) {
  const state = { terminal: null, violation: null };
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let stdoutBytes = 0;
  let eventCount = 0;
  let chain = Promise.resolve();
  const killWith = (error) => {
    if (!state.violation) {
      state.violation = error;
      try {
        abortChild();
      } catch {
        /* already exited */
      }
    }
  };
  const handleLine = async (line) => {
    if (state.violation) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error('bridge emitted non-JSON stdout; child killed');
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('bridge emitted a non-object event; child killed');
    }
    if (obj.bridge !== 'runtime-bridge-v1' || obj.run_id !== taskId) {
      throw new Error('bridge event run_id/bridge mismatch; child killed');
    }
    if (obj.event === 'result') {
      if (state.terminal) throw new Error('bridge emitted multiple result events; child killed');
      state.terminal = obj;
      return;
    }
    await onProgressEvent(obj);
  };
  child.stdout.on('data', (chunk) => {
    if (state.violation) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > BRIDGE_STDOUT_CAP_BYTES) {
      killWith(new Error('bridge stdout exceeded 8 MiB; child killed'));
      return;
    }
    buffered += decoder.write(chunk);
    let idx;
    while ((idx = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 1);
      if (line.length > BRIDGE_LINE_CAP_CHARS) {
        killWith(new Error('bridge line exceeds 256 KiB; child killed'));
        return;
      }
      if (!line.trim()) continue;
      eventCount += 1;
      if (eventCount > BRIDGE_EVENT_CAP) {
        killWith(new Error('bridge emitted more than 2000 events; child killed'));
        return;
      }
      chain = chain.then(() => handleLine(line)).catch((error) => killWith(error));
    }
  });
  return {
    get terminal() {
      return state.terminal;
    },
    get violation() {
      return state.violation;
    },
    kill(error) {
      killWith(error instanceof Error ? error : new Error(String(error)));
    },
    async drained() {
      await chain.catch(() => {});
    },
  };
}

async function settleTerminal(broker, owner, task, terminal, workspace) {
  const db = broker.store.db;
  const input = task.input ?? {};
  switch (terminal.status) {
    case 'completed': {
      const artifacts = Array.isArray(terminal.artifacts) ? terminal.artifacts : [];
      if (artifacts.length > ARTIFACT_MAX_COUNT) {
        await cascadeCancelDescendants(broker, owner, task.id);
        return { status: 'failed', error: 'too many artifacts declared' };
      }
      const artifactIds = [];
      for (const declared of artifacts) {
        const stored = ingestArtifact(db, owner, task.id, workspace, declared);
        if (!stored.ok) {
          await cascadeCancelDescendants(broker, owner, task.id);
          return { status: 'failed', error: stored.error };
        }
        artifactIds.push(stored.id);
      }
      const output = typeof terminal.output === 'string' ? terminal.output.slice(0, 20000) : '';
      const kids = await directChildren(broker, owner, task.id);
      const active = kids.filter((k) => !isChildTerminal(k.status));
      if (active.length > 0) {
        const childIds = kids.map((k) => k.id);
        return {
          status: 'waiting_children',
          childIds,
          artifactIds: [...(task.artifactIds ?? []), ...artifactIds],
          state: {
            ...(task.state ?? {}),
            lastTerminal: 'waiting_children',
            waitingChildren: { childIds, createdAt: new Date().toISOString() },
            pendingOutput: output.slice(0, 2000),
          },
        };
      }
      // Private child results stay home: only roots publish to the
      // conversation; delegated children aggregate via child_results.
      if (!task.parentTaskId) {
        publishAssistantMessage(db, owner, input.conversationId, task.id, output);
      }
      return {
        status: 'succeeded',
        result: output,
        artifactIds: [...(task.artifactIds ?? []), ...artifactIds],
        state: { ...(task.state ?? {}), lastTerminal: 'completed' },
      };
    }
    case 'failed': {
      const message =
        typeof terminal.error?.message === 'string'
          ? terminal.error.message
          : typeof terminal.error === 'string'
            ? terminal.error
            : 'Runtime reported failure';
      await cascadeCancelDescendants(broker, owner, task.id);
      return { status: 'failed', error: message.slice(0, 2000), state: { ...(task.state ?? {}), lastTerminal: 'failed' } };
    }
    case 'cancelled':
      await cascadeCancelDescendants(broker, owner, task.id);
      return {
        status: 'cancelled',
        result: typeof terminal.output === 'string' ? terminal.output.slice(0, 2000) : '',
        state: { ...(task.state ?? {}), lastTerminal: 'cancelled' },
      };
    case 'waiting_input': {
      const questions = Array.isArray(terminal.questions) ? terminal.questions : [];
      if (questions.length === 0) return { status: 'failed', error: 'Runtime asked for input without questions' };
      const kids = await directChildren(broker, owner, task.id);
      return {
        status: 'waiting_input',
        question: String(questions[0]?.prompt ?? 'Input needed').slice(0, 500),
        questions: questions.map((q) => ({ id: String(q.id), prompt: String(q.prompt ?? '').slice(0, 1000) })),
        childIds: kids.map((k) => k.id),
        state: { ...(task.state ?? {}), lastTerminal: 'waiting_input' },
      };
    }
    case 'awaiting_approval': {
      const approvals = Array.isArray(terminal.approvals) ? terminal.approvals : [];
      if (approvals.length === 0) return { status: 'failed', error: 'Runtime requested approval without approvals' };
      const now = new Date().toISOString();
      const pending = [];
      for (const a of approvals) {
        const runtimeId = String(a?.id ?? '');
        if (!runtimeId) return { status: 'failed', error: 'Runtime approval is missing an id' };
        // Public approval IDs are namespaced per task: runtime IDs (often a
        // terse "a1") would otherwise collide across two simultaneous tasks
        // of the same owner sharing one actions namespace. The bridge keeps
        // receiving its own runtime IDs on resume (mapped back below).
        const publicId = `${task.id}:${runtimeId}`;
        await broker.store.put(owner, 'actions', {
          id: publicId,
          runtimeId,
          taskId: task.id,
          status: 'awaiting_review',
          action: String(a.action ?? '').slice(0, 500),
          args: a.args !== undefined && a.args !== null ? a.args : {},
          reason: String(a.reason ?? '').slice(0, 1000),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          createdAt: now,
        });
        pending.push({
          id: publicId,
          action: String(a.action ?? '').slice(0, 500),
          args: a.args !== undefined && a.args !== null ? a.args : {},
          reason: String(a.reason ?? '').slice(0, 1000),
        });
      }
      const wkids = await directChildren(broker, owner, task.id);
      return {
        status: 'waiting_approval',
        actionId: pending[0].id,
        pendingApprovals: pending,
        childIds: wkids.map((k) => k.id),
        state: { ...(task.state ?? {}), lastTerminal: 'awaiting_approval' },
      };
    }
    case 'waiting_children':
    case 'awaiting_children': {
      const declared = Array.isArray(terminal.children)
        ? terminal.children
        : Array.isArray(terminal.child_ids)
          ? terminal.child_ids
          : null;
      const kids = await directChildren(broker, owner, task.id);
      if (kids.length === 0) {
        return { status: 'failed', error: 'Runtime waited for children but none exist' };
      }
      const known = new Set(kids.map((k) => k.id));
      if (declared) {
        for (const id of declared) {
          if (typeof id !== 'string' || !known.has(id)) {
            return { status: 'failed', error: 'Runtime waited for unknown child' };
          }
        }
      }
      const childIds = kids.map((k) => k.id);
      const allSettled = kids.every((k) => isChildTerminal(k.status));
      if (allSettled) {
        const childResults = await buildChildResults(broker, owner, kids);
        return {
          status: 'queued',
          input: { ...input, resume: { childResults } },
          childIds,
          state: {
            ...(task.state ?? {}),
            lastTerminal: 'waiting_children',
            waitingChildren: { childIds, createdAt: new Date().toISOString() },
          },
        };
      }
      return {
        status: 'waiting_children',
        childIds,
        state: {
          ...(task.state ?? {}),
          lastTerminal: 'waiting_children',
          waitingChildren: { childIds, createdAt: new Date().toISOString() },
        },
      };
    }
    default:
      return { status: 'failed', error: 'Unknown bridge result status' };
  }
}

async function buildChildResults(broker, owner, kids) {
  const out = [];
  for (const k of kids) {
    const fresh = (await broker.store.get(owner, 'tasks', k.id)) ?? k;
    if (fresh.status === 'succeeded') {
      const arts = broker.store.db
        .prepare('SELECT id, name, sha256, size FROM artifacts WHERE owner_id = ? AND task_id = ? ORDER BY created_at, id')
        .all(owner, fresh.id);
      out.push({
        id: fresh.id,
        status: 'succeeded',
        output: String(fresh.result ?? '').slice(0, 2000),
        artifacts: arts.map((a) => ({ id: a.id, name: a.name, sha256: a.sha256, size: a.size })),
      });
    } else if (fresh.status === 'failed') {
      out.push({ id: fresh.id, status: 'failed', error: String(fresh.error ?? 'child failed').slice(0, 2000) });
    } else if (fresh.status === 'cancelled') {
      out.push({ id: fresh.id, status: 'cancelled' });
    } else {
      out.push({ id: fresh.id, status: fresh.status });
    }
  }
  return out.slice(0, 50);
}

async function tryWakeParent(broker, owner, parentId) {
  const parent = await broker.store.get(owner, 'tasks', parentId);
  if (!parent || parent.status !== 'waiting_children') return false;
  const kids = await directChildren(broker, owner, parentId);
  if (kids.length === 0) return false;
  if (!kids.every((k) => isChildTerminal(k.status))) return false;
  const childResults = await buildChildResults(broker, owner, kids);
  const next = await broker.store.compareAndSwap(
    owner,
    'tasks',
    parentId,
    { status: 'waiting_children' },
    {
      status: 'queued',
      updatedAt: new Date().toISOString(),
      input: { ...(parent.input ?? {}), resume: { childResults } },
      state: sansBoot(parent.state),
    },
  );
  if (next) broker.kick();
  return Boolean(next);
}

async function handleSettled(broker, owner, task) {
  if (!task) return;
  // Failure cascade covers every worker failure path, not only normal
  // terminal results: a malformed-stdout kill, child crash, wall-timeout, or
  // spawn error marks the task failed via the worker catch path (bypassing
  // settleTerminal), so cascade here for ANY failed/cancelled task —
  // including roots with no parent. The single-CAS wake below cannot
  // requeue a cancelled parent (expected status waiting_children fails).
  if (task.status === 'failed' || task.status === 'cancelled') {
    try {
      await cascadeCancelDescendants(broker, owner, task.id);
    } catch (error) {
      console.error(`[tasks] settled cascade failed: ${error?.message ?? error}`);
    }
  }
  // H7.1 notification outbox (side effect only): human-wait alerts fire for
  // ANY owned task — a delegated child asking while the phone is closed must
  // still alert, or the workflow stalls silently. Completion/failure/cancel
  // alerts stay root-only (the outbox filter enforces this). Enqueue is
  // synchronous SQLite + dedupe; pump failures never touch task state.
  // Cancel/wake behavior above is preserved verbatim.
  try {
    broker.notifications?.enqueueForTask(owner, task);
  } catch (error) {
    console.error(`[notifications] settled enqueue failed: ${error?.message ?? error}`);
  }
  if (broker.notifications) {
    void broker.notifications.pump().catch((error) =>
      console.error(`[notifications] settled pump failed: ${error?.message ?? error}`),
    );
  }
  if (!task?.parentTaskId) return;
  if (!isChildTerminal(task.status)) return;
  await tryWakeParent(broker, owner, task.parentTaskId);
}

async function reconcileWaitingParents(broker) {
  const all = await broker.store.scan('tasks');
  for (const { owner, value } of all) {
    if (value?.status === 'waiting_children') {
      await tryWakeParent(broker, owner, value.id);
    }
  }
  // Orphan cleanup on restart: children of terminal failed/cancelled parents
  // that are still non-terminal can never be awaited — cancel them closed.
  // Waiting parents reconcile without replaying completed external actions.
  for (const { owner, value } of all) {
    if (!value?.parentTaskId) continue;
    if (['queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_children'].includes(value.status)) {
      const parent = await broker.store.get(owner, 'tasks', value.parentTaskId);
      if (parent && ['failed', 'cancelled'].includes(parent.status)) {
        await broker.store.compareAndSwap(
          owner,
          'tasks',
          value.id,
          { status: value.status },
          {
            status: 'cancelled',
            leaseId: null,
            leaseUntil: null,
            updatedAt: new Date().toISOString(),
            state: sansBoot(value.state),
          },
        );
      }
    }
  }
}

async function cascadeCancelDescendants(broker, owner, parentId) {
  const visited = new Set([parentId]);
  const queue = [parentId];
  while (queue.length > 0) {
    const current = queue.shift();
    const kids = await directChildren(broker, owner, current);
    for (const kid of kids) {
      if (visited.has(kid.id)) continue;
      visited.add(kid.id);
      queue.push(kid.id);
      const latest = (await broker.store.get(owner, 'tasks', kid.id)) ?? kid;
      if (['queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_children'].includes(latest.status)) {
        await broker.store.compareAndSwap(
          owner,
          'tasks',
          kid.id,
          { status: latest.status },
          {
            status: 'cancelled',
            leaseId: null,
            leaseUntil: null,
            updatedAt: new Date().toISOString(),
            state: sansBoot(latest.state),
          },
        );
        deleteAssistantMessages(broker.store.db, kid.id);
        try { broker.worker.abort(kid.id); } catch { /* already gone */ }
        const childProc = broker.children.get(kid.id);
        if (childProc) {
          try { childProc.kill('SIGTERM'); } catch { /* already exited */ }
        }
      }
    }
  }
}

export function validateArtifactPath(workspace, declaredPath) {
  if (typeof declaredPath !== 'string' || !declaredPath) return { ok: false, error: 'artifact path missing' };
  const normalized = posix.normalize(declaredPath.replace(/\\/g, '/'));
  if (isAbsolute(normalized) || normalized.startsWith('..') || normalized.startsWith('.me_runtime')) {
    return { ok: false, error: `artifact path escapes workspace: ${declaredPath}` };
  }
  const full = resolve(workspace, normalized);
  if (full !== resolve(workspace) && !full.startsWith(resolve(workspace) + sep)) {
    return { ok: false, error: `artifact path escapes workspace: ${declaredPath}` };
  }
  return { ok: true, full, name: normalized };
}

// Artifact ingest (H5). The declared path is untrusted runtime output, so
// every step is defensive: lexical containment first, then realpath
// containment (resolves intermediate and final symlinks — a link pointing at
// another household user's workspace fails here), then open with O_NOFOLLOW
// (a swapped-in final symlink fails instead of being followed), fstat type
// and size checks BEFORE any read, and a bounded exact-size read loop.
// Residual TOCTOU between realpath and open is documented: the only writer is
// the task's own runtime inside its 0700 workspace, and O_NOFOLLOW + isFile +
// size-first + bounded read close the practical holes.
export function ingestArtifact(db, owner, taskId, workspace, declared, limits = {}) {
  const maxCount = limits.maxCount ?? ARTIFACT_MAX_COUNT;
  const maxTotalBytes = limits.maxTotalBytes ?? ARTIFACT_MAX_TOTAL_BYTES;
  const maxBytes = limits.maxBytes ?? ARTIFACT_MAX_BYTES;
  const stats = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS total FROM artifacts WHERE owner_id = ? AND task_id = ?')
    .get(owner, taskId);
  if (stats.count >= maxCount) {
    return { ok: false, error: `too many artifacts for task (max ${maxCount})` };
  }
  const checked = validateArtifactPath(workspace, declared?.path);
  if (!checked.ok) return checked;
  const wsRoot = resolve(workspace);
  let wsReal;
  try {
    // Compare against the canonical workspace root: on hosts where temp/data
    // paths contain symlinks (e.g. macOS /var -> /private/var), a lexical
    // comparison would reject legitimate artifacts.
    wsReal = realpathSync(wsRoot);
  } catch {
    return { ok: false, error: `workspace unavailable: ${declared?.path}` };
  }
  let real;
  try {
    real = realpathSync(checked.full);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      return { ok: false, error: `artifact path is a symlink loop: ${declared?.path}` };
    }
    return { ok: false, error: `declared artifact not found: ${declared?.path}` };
  }
  if (real !== wsReal && !real.startsWith(wsReal + sep)) {
    return { ok: false, error: `artifact path escapes workspace: ${declared?.path}` };
  }
  let fd = -1;
  try {
    try {
      fd = openSync(
        checked.full,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (error) {
      if (error?.code === 'ELOOP') {
        return { ok: false, error: `artifact must not be a symlink: ${declared?.path}` };
      }
      return { ok: false, error: `declared artifact not found: ${declared?.path}` };
    }
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, error: `artifact is not a regular file: ${declared?.path}` };
    }
    if (st.size > maxBytes) {
      return { ok: false, error: `artifact too large: ${declared?.path}` };
    }
    if (stats.total + st.size > maxTotalBytes) {
      return { ok: false, error: 'artifacts exceed task budget' };
    }
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const read = readSync(fd, bytes, offset, st.size - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const data = offset === st.size ? bytes : bytes.subarray(0, offset);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (typeof declared?.sha256 === 'string' && declared.sha256 !== sha256) {
      return { ok: false, error: `artifact checksum mismatch: ${declared?.path}` };
    }
    if (Number.isInteger(declared?.bytes) && declared.bytes !== data.length) {
      return { ok: false, error: `artifact size mismatch: ${declared?.path}` };
    }
    const id = newId('art');
    db.prepare(
      'INSERT INTO artifacts(id, owner_id, task_id, name, bytes, sha256, size, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, owner, taskId, checked.name, data, sha256, data.length, Date.now());
    return { ok: true, id };
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

// Completed task output is published into its authorized conversation as an
// assistant message, bound to the task ID. INSERT OR IGNORE over the partial
// unique index makes repeat publication idempotent: restarts, recovery
// backfills, and re-settles can never duplicate the assistant message.
export function publishAssistantMessage(db, owner, conversationId, taskId, output) {
  const body = String(output ?? '').trim();
  if (!conversationId || !taskId || !body) return { ok: false, skipped: true };
  const id = newId('msg');
  const now = Date.now();
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO messages(id, conversation_id, author_user_id, author_device_id, role, body, request_key, task_id, created_at) VALUES(?, ?, ?, NULL, ?, ?, NULL, ?, ?)',
    )
    .run(id, conversationId, owner, 'assistant', body.slice(0, 20000), taskId, now);
  return { ok: true, inserted: res.changes === 1, id };
}

export function deleteAssistantMessages(db, taskId) {
  if (!taskId) return;
  db.prepare("DELETE FROM messages WHERE task_id = ? AND role = 'assistant'").run(taskId);
}

function conversationContext(broker, owner, conversationId) {  try {
    const rows = broker.store.db
      .prepare('SELECT id, role, body FROM messages WHERE conversation_id = ? AND author_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10')
      .all(conversationId, owner)
      .reverse();
    return rows.map((m) => ({ kind: 'message', id: m.id, role: m.role, text: String(m.body).slice(0, 2000) }));
  } catch {
    return [];
  }
}

async function answerTask(broker, owner, taskId, inputs) {
  const task = await broker.store.get(owner, 'tasks', taskId);
  if (!task) return { found: false };
  if (task.status !== 'waiting_input') {
    return { found: true, conflict: `task is ${task.status}, not waiting_input` };
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw Object.assign(new Error('inputs must be a non-empty array'), { code: 'bad_request' });
  }
  const pending = new Set((task.questions ?? []).map((q) => q.id));
  for (const item of inputs) {
    if (!pending.has(item?.id)) {
      throw Object.assign(new Error(`unknown question: ${item?.id}`), { code: 'bad_request' });
    }
    if (typeof item?.answer !== 'string' || !item.answer.trim() || item.answer.length > 4000) {
      throw Object.assign(new Error('answer must be non-empty text up to 4000 chars'), { code: 'bad_request' });
    }
  }
  const next = await broker.store.compareAndSwap(
    owner,
    'tasks',
    taskId,
    { status: 'waiting_input' },
    {
      status: 'queued',
      updatedAt: new Date().toISOString(),
      input: { ...task.input, resume: { inputs } },
      state: sansBoot(task.state),
    },
  );
  if (!next) return { found: true, conflict: 'task changed state concurrently' };
  broker.kick();
  return { found: true, task: next };
}

async function decideApprovals(broker, owner, taskId, approvals) {
  if (!Array.isArray(approvals) || approvals.length === 0) {
    throw Object.assign(new Error('approvals must be a non-empty array'), { code: 'bad_request' });
  }
  for (const item of approvals) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('approval must be an object'), { code: 'bad_request' });
    }
    if (typeof item.id !== 'string' || !item.id) {
      throw Object.assign(new Error('approval id is required'), { code: 'bad_request' });
    }
    if (item.decision !== 'approve' && item.decision !== 'reject') {
      throw Object.assign(new Error('decision must be approve or reject'), { code: 'bad_request' });
    }
    if (item.note !== undefined && typeof item.note !== 'string') {
      throw Object.assign(new Error('note must be a string'), { code: 'bad_request' });
    }
  }
  // Atomic one-use transition: task + every approval record move together in
  // one IMMEDIATE transaction. A failed action check (decided, rebound,
  // expired) aborts everything, so a decision is never forwarded without its
  // record — and a lost task race never strands decided-but-unforwarded rows
  // (the resume payload and the records are written together).
  const db = broker.store.db;
  db.exec('BEGIN IMMEDIATE');
  let outcome;
  let commit = false;
  try {
    const read = (kind, id) => {
      const row = db
        .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?')
        .get(owner, kind, id);
      return row ? JSON.parse(row.data) : null;
    };
    const write = (kind, value) => {
      db.prepare('UPDATE records SET data = ?, updated_at = ? WHERE owner = ? AND kind = ? AND id = ?').run(
        JSON.stringify(value),
        Date.now(),
        owner,
        kind,
        value.id,
      );
    };
    const task = read('tasks', taskId);
    if (!task) {
      outcome = { found: false };
    } else if (task.status !== 'waiting_approval') {
      outcome = { found: true, conflict: `task is ${task.status}, not waiting_approval` };
    } else {
      const pendingById = new Map((task.pendingApprovals ?? []).map((a) => [a.id, a]));
      for (const item of approvals) {
        if (!pendingById.has(item.id)) {
          throw Object.assign(new Error(`unknown approval: ${item.id}`), { code: 'bad_request' });
        }
      }
      const now = Date.now();
      const resumeApprovals = [];
      let conflict = null;
      for (const item of approvals) {
        const action = read('actions', item.id);
        if (!action || action.taskId !== taskId) {
          conflict = 'approval is not bound to this task';
          break;
        }
        if (action.status !== 'awaiting_review' || action.decidedAt) {
          conflict = 'approval was already decided';
          break;
        }
        if (action.expiresAt && Date.parse(action.expiresAt) <= now) {
          conflict = 'approval expired';
          break;
        }
        action.status = item.decision === 'approve' ? 'approved' : 'rejected';
        action.decidedAt = new Date(now).toISOString();
        action.note = typeof item.note === 'string' ? item.note.slice(0, 1000) : '';
        write('actions', action);
        // Map back to the runtime's own IDs and replay the exact args the
        // runtime proposed: the bridge re-validates args binding on resume.
        // Capabilities are untouched — approval never widens the ceiling.
        resumeApprovals.push({ id: action.runtimeId, decision: item.decision, args: action.args ?? {} });
      }
      if (conflict) {
        outcome = { found: true, conflict };
      } else {
        task.status = 'queued';
        task.updatedAt = new Date(now).toISOString();
        task.input = { ...task.input, resume: { approvals: resumeApprovals } };
        task.state = sansBoot(task.state);
        write('tasks', task);
        outcome = { found: true };
        commit = true;
      }
    }
    db.exec(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw error;
  }
  if (!outcome.found || outcome.conflict) return outcome;
  broker.kick();
  return { found: true };
}

async function cancelTask(broker, owner, taskId) {
  const task = await broker.store.get(owner, 'tasks', taskId);
  if (!task) return { found: false };
  if (!['queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_children'].includes(task.status)) {
    return { found: true, conflict: `task is already ${task.status}` };
  }
  const next = await broker.store.compareAndSwap(
    owner,
    'tasks',
    taskId,
    { status: task.status },
    {
      status: 'cancelled',
      leaseId: null,
      leaseUntil: null,
      updatedAt: new Date().toISOString(),
      state: sansBoot(task.state),
    },
  );
  if (!next) return { found: true, conflict: 'task changed state concurrently' };
  // A run that was in flight may have published its assistant message before
  // its settle checkpoint was rejected by this cancel; remove it so a
  // cancelled task never leaves task-bound output in the conversation.
  deleteAssistantMessages(broker.store.db, taskId);
  broker.worker.abort(taskId);
  const child = broker.children.get(taskId);
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }
  await cascadeCancelDescendants(broker, owner, taskId);
  // H7: a root cancel is a completion event for the outbox. Side effect only;
  // failures here never change the cancel outcome above.
  if (!next.parentTaskId) {
    try {
      broker.notifications?.enqueueForTask(owner, next);
    } catch (error) {
      console.error(`[notifications] cancel enqueue failed: ${error?.message ?? error}`);
    }
    if (broker.notifications) {
      void broker.notifications.pump().catch((error) =>
        console.error(`[notifications] cancel pump failed: ${error?.message ?? error}`),
      );
    }
  }
  return { found: true, task: next };
}

function summarize(task, childIds = null) {
  const kids = childIds ?? task.childIds ?? [];
  return {
    id: task.id,
    conversation_id: task.input?.conversationId ?? null,
    title: task.title,
    status: task.status,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    attempts: task.attempts,
    parent_task_id: task.parentTaskId ?? null,
    root_task_id: task.rootTaskId ?? task.id,
    depth: task.depth ?? 0,
    children: kids,
    ...(task.error ? { error: task.error } : {}),
    ...(task.question ? { question: task.question } : {}),
    artifact_ids: task.artifactIds ?? [],
  };
}

async function taskView(broker, owner, taskId, { withProgress }) {
  const task = await broker.store.get(owner, 'tasks', taskId);
  if (!task) return null;
  const kids = await directChildren(broker, owner, taskId);
  const view = {
    ...summarize(task, kids.map((k) => k.id)),
    questions: task.questions ?? undefined,
    pending_approvals: task.pendingApprovals ?? undefined,
    capabilities: task.input?.capabilities ?? undefined,
    budgets: task.input?.budgets ?? undefined,
    children_status: kids.map((k) => ({ id: k.id, status: k.status })),
    ...(task.state?.waitingChildren ? { waiting_for: task.state.waitingChildren.childIds ?? [] } : {}),
    ...(task.childIds && task.childIds.length > 0 && task.status === 'waiting_children'
      ? { waiting_for: task.childIds }
      : {}),
    ...(task.input?.model
      ? {
          model: {
            provider: task.input.model.provider,
            model: task.input.model.model,
            ...(task.input.model.use_responses_api === true ? { use_responses_api: true } : {}),
          },
        }
      : {}),
    ...(task.result ? { output: task.result } : {}),
  };
  const artifacts = await broker.artifactList(owner, taskId);
  view.artifacts = artifacts.map((a) => ({ id: a.id, name: a.name, sha256: a.sha256, size: a.size, created_at: a.created_at }));
  if (withProgress) {
    const events = (await broker.store.list(owner, 'run-events'))
      .filter((e) => e.taskId === taskId)
      .slice(-50)
      .map((e) => ({ date: e.date, kind: e.kind, title: e.title }));
    view.progress = events;
  }
  return view;
}
