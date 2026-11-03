// H7 opt-in private task notifications (Expo push, metadata-only).
//
// Design constraints:
// - Defaults disabled / no outbound network. Per-phone consent (permission_enabled)
//   + operator opt-in (HOME_NOTIFICATIONS_ENABLED=1) both required before any fetch.
// - Fixed Expo origin only; no arbitrary user webhook URLs (no SSRF surface).
//   Redirects are never followed (provider bearer/push address never forwarded).
// - Payload is metadata only: installation_id/task_id/device_id/kind/event_id.
//   Generic title/body only; never conversation titles, user text, output,
//   errors, browser data, or credentials. Home hosts private history.
// - Identity always derives from the session (device-me); client-supplied
//   user/device IDs are never trusted.
// - Tokens live in the 0600 SQLite file only, never in logs or API responses.
// - Outbox is at-least-once with stable event IDs so the phone can dedupe.
//   Human-wait alerts (waiting_input/waiting_approval) fire for ANY owned task
//   (a delegated child asking while the phone is closed must still alert);
//   completion/failure/cancel alerts stay root-only to suppress storms.
// - Delivery claims durable per-row leases (CAS) fenced by lease id, so
//   concurrent pumps — even from two processes on one DB — send once.
// - Expo receipts arrive late: tickets accepted at send time are marked sent
//   and receipts are polled later with bounded retries. An accepted
//   notification is never resent. DeviceNotRegistered disables the binding.
// - Network failure never fails a task; stale (answered/revoked) alerts drop.

import { createHash, randomUUID } from 'node:crypto';

export const EXPO_ORIGIN = 'https://exp.host';
export const EXPO_PUSH_URL = `${EXPO_ORIGIN}/--/api/v2/push/send`;
export const EXPO_RECEIPT_URL = `${EXPO_ORIGIN}/--/api/v2/push/getReceipts`;
// Bounded response parsing: Expo tickets/receipts are tiny JSON; anything
// larger is rejected before it can bloat the home.
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_RECEIPT_IDS_PER_CALL = 100;

export const NOTIFICATION_KINDS = new Set([
  'waiting_input',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
]);
const HUMAN_WAIT_KINDS = new Set(['waiting_input', 'waiting_approval']);

// Official Expo push token shape: ExponentPushToken[...] / ExpoPushToken[...]
const EXPO_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9\-_]{1,128}\]$/;
export const MAX_TOKEN_CHARS = 256;
export const MAX_ACTIVE_REGISTRATIONS_PER_USER = 10;
export const MAX_PENDING_OUTBOX = 500;
// Retention bounds for transient outbox rows (never task history).
export const MAX_OUTBOX_ROWS = 2000;

export function isExpoTokenFormat(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= MAX_TOKEN_CHARS && EXPO_TOKEN_RE.test(value);
}

export function tokenSuffix(token) {
  const s = String(token ?? '');
  return s.length <= 8 ? `…${s}` : `…${s.slice(-8)}`;
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token), 'utf8').digest();
}

function isExpoUrl(url) {
  try {
    return new URL(url).origin === EXPO_ORIGIN;
  } catch {
    return false;
  }
}

export function resolveNotificationConfig(env = process.env) {
  const raw = env.HOME_NOTIFICATIONS_ENABLED;
  const enabled = raw === '1' || String(raw ?? '').toLowerCase() === 'true';
  if (!enabled) return { enabled: false };
  const num = (v, fallback, min, max) => {
    if (v === undefined || v === null || String(v).trim() === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`Invalid notification tuning value: ${v}`);
    }
    return n;
  };
  return {
    enabled: true,
    // Public project identifier the phone app was built with (operator config).
    projectId: typeof env.HOME_EXPO_PROJECT_ID === 'string' && env.HOME_EXPO_PROJECT_ID.trim()
      ? env.HOME_EXPO_PROJECT_ID.trim().slice(0, 128)
      : null,
    // Optional per-home Expo access token. Kept in memory only: never stored
    // in SQLite, never returned over HTTP, never logged, never passed to the
    // runtime bridge child (see buildRuntimeEnv in task-broker.mjs).
    accessToken: typeof env.HOME_EXPO_ACCESS_TOKEN === 'string' && env.HOME_EXPO_ACCESS_TOKEN.trim()
      ? env.HOME_EXPO_ACCESS_TOKEN.trim()
      : null,
    maxAttempts: num(env.HOME_NOTIF_MAX_ATTEMPTS, 8, 1, 20),
    baseDelayMs: num(env.HOME_NOTIF_BASE_DELAY_MS, 5000, 100, 60000),
    maxDelayMs: num(env.HOME_NOTIF_MAX_DELAY_MS, 15 * 60 * 1000, 1000, 60 * 60 * 1000),
    batchSize: num(env.HOME_NOTIF_BATCH_SIZE, 10, 1, 50),
    sendTimeoutMs: num(env.HOME_NOTIF_SEND_TIMEOUT_MS, 8000, 1000, 30000),
    expiryMs: num(env.HOME_NOTIF_EXPIRY_MS, 24 * 60 * 60 * 1000, 60 * 1000, 7 * 24 * 60 * 60 * 1000),
    pumpIntervalMs: num(env.HOME_NOTIF_PUMP_MS, 15000, 1000, 120000),
    // H7.1 durable delivery tuning.
    leaseMs: num(env.HOME_NOTIF_LEASE_MS, 60000, 5000, 300000),
    receiptDelayMs: num(env.HOME_NOTIF_RECEIPT_DELAY_MS, 30000, 0, 3600000),
    receiptMaxAttempts: num(env.HOME_NOTIF_RECEIPT_MAX_ATTEMPTS, 10, 1, 50),
    receiptBatch: num(env.HOME_NOTIF_RECEIPT_BATCH, 50, 1, 100),
    retentionMs: num(env.HOME_NOTIF_RETENTION_MS, 7 * 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000),
    outboxMaxRows: num(env.HOME_NOTIF_MAX_ROWS, MAX_OUTBOX_ROWS, 100, 10000),
  };
}

// ---- Providers -------------------------------------------------------------

// Read a fetch Response body with a hard byte cap. The whole read races the
// abort signal, so stalled or oversized bodies (which ignore backpressure)
// still resolve bounded. Never logs bodies or headers.
async function readBoundedJson(res, maxBytes, signal) {
  const abortError = () => signal?.aborted
    ? new Error(`push response aborted: ${signal.reason?.message ?? signal.reason ?? 'aborted'}`)
    : null;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const onAbort = () => { try { reader.cancel(signal?.reason); } catch { /* best effort */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const chunks = [];
      let total = 0;
      for (;;) {
        const aborted = abortError();
        if (aborted) throw aborted;
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(abortError());
              return;
            }
            signal?.addEventListener?.('abort', () => reject(abortError()), { once: true });
          }),
        ]);
        if (done) break;
        const bytes = value?.length ?? 0;
        total += bytes;
        if (total > maxBytes) throw new Error(`push response exceeds ${maxBytes} bytes; discarded`);
        chunks.push(value);
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('push response is not valid JSON');
      }
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      try { reader.releaseLock(); } catch { /* best effort */ }
    }
  }
  // Non-streaming (test doubles): still bounded, still abort-aware.
  const text = await Promise.race([
    res.text(),
    new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener?.('abort', () => reject(abortError()), { once: true });
    }),
  ]);
  if (text.length > maxBytes) throw new Error(`push response exceeds ${maxBytes} bytes; discarded`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('push response is not valid JSON');
  }
}

// Single fixed-origin POST with a deadline covering the ENTIRE exchange
// (headers + bounded body parse). Redirects are refused, never followed, so
// the provider bearer token and push addresses cannot be forwarded elsewhere.
// The abort signal genuinely aborts the underlying request; the timeout is not
// just a race that leaks the socket.
async function postExpoJson({ url, headers, bodyJson, timeoutMs, fetchImpl, maxBytes, signal, what }) {
  if (!isExpoUrl(url)) throw new Error(`${what}: refusing non-Expo endpoint`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try { ctrl.abort(new Error(`${what} timed out after ${timeoutMs}ms`)); } catch { /* best effort */ }
  }, timeoutMs);
  const onExternalAbort = () => {
    try { ctrl.abort(signal?.reason ?? new Error(`${what} aborted`)); } catch { /* best effort */ }
  };
  if (signal?.aborted) {
    clearTimeout(timer);
    throw new Error(`${what} aborted before send: ${signal.reason?.message ?? signal.reason ?? 'aborted'}`);
  }
  signal?.addEventListener?.('abort', onExternalAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: bodyJson,
      redirect: 'error',
      signal: ctrl.signal,
    });
    // Final origin/status checks: a 3xx here (e.g. a test double that does not
    // enforce redirect:'error') is refused, never followed.
    if (res.redirected) throw new Error(`${what}: redirect refused, never followed`);
    try {
      const finalUrl = res.url || url;
      if (!isExpoUrl(finalUrl)) throw new Error(`${what}: final origin mismatch, refused`);
    } catch (error) {
      if (String(error?.message ?? '').includes('refused')) throw error;
      // Unparseable URL on a double: treat as mismatch only when present.
      if (res.url) throw new Error(`${what}: final origin mismatch, refused`);
    }
    if (typeof res.status === 'number' && res.status >= 300 && res.status < 400) {
      throw new Error(`${what}: redirect (${res.status}) refused, never followed`);
    }
    if (res.ok === false || (typeof res.status === 'number' && (res.status < 200 || res.status >= 300))) {
      throw new Error(`${what}: unexpected HTTP ${res.status}`);
    }
    return await readBoundedJson(res, maxBytes, ctrl.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onExternalAbort);
  }
}

// Official Expo push HTTP protocol over the single fixed origin. No SDK
// dependency (no new npm packages, no lockfile churn). Never called unless
// the operator opted in. `fetchImpl` is injectable so tests never touch the
// real Expo API.
export function createExpoHttpProvider({ accessToken = null, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return {
    name: 'expo-http',
    async sendBatch(messages, { signal } = {}) {
      if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) {
        throw new Error('sendBatch: expected 1..50 messages');
      }
      const json = await postExpoJson({
        url: EXPO_PUSH_URL,
        headers,
        bodyJson: JSON.stringify(messages),
        timeoutMs,
        fetchImpl,
        maxBytes: MAX_RESPONSE_BYTES,
        signal,
        what: 'Expo push send',
      });
      // Expo returns {data:[{status:'ok',id}|{status:'error',message,details}]}.
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== messages.length) {
        throw new Error('Unexpected Expo push response shape');
      }
      return data.map((t) => {
        if (t?.status === 'ok') return { ticketStatus: 'ok', ticketId: typeof t.id === 'string' ? t.id : null };
        return {
          ticketStatus: 'error',
          message: String(t?.message ?? 'push rejected').slice(0, 300),
          details: t?.details ?? null,
        };
      });
    },
    async getReceipts(ids, { signal } = {}) {
      if (!Array.isArray(ids) || ids.length === 0) return {};
      if (ids.length > MAX_RECEIPT_IDS_PER_CALL) {
        throw new Error(`getReceipts: at most ${MAX_RECEIPT_IDS_PER_CALL} ids per call`);
      }
      if (ids.some((id) => typeof id !== 'string' || !id || id.length > 256)) {
        throw new Error('getReceipts: receipt ids must be non-empty strings');
      }
      const json = await postExpoJson({
        url: EXPO_RECEIPT_URL,
        headers,
        bodyJson: JSON.stringify({ ids }),
        timeoutMs,
        fetchImpl,
        maxBytes: MAX_RESPONSE_BYTES,
        signal,
        what: 'Expo receipt poll',
      });
      const data = json?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Unexpected Expo receipt response shape');
      }
      return data;
    },
  };
}

// Disabled default: any accidental send attempt throws instead of touching the network.
export function createDisabledProvider() {
  const err = () => { throw Object.assign(new Error('Notifications are disabled on this home'), { code: 'notifications_disabled' }); };
  return { name: 'disabled', sendBatch: async () => { err(); }, getReceipts: async () => { err(); } };
}

export function isDeviceNotRegisteredTicket(t) {
  const hay = `${t?.message ?? ''} ${JSON.stringify(t?.details ?? '')}`;
  return /DeviceNotRegistered/i.test(hay);
}

export function isDeviceNotRegisteredReceipt(r) {
  const hay = `${r?.message ?? ''} ${JSON.stringify(r?.details ?? r ?? '')}`;
  return /DeviceNotRegistered/i.test(hay);
}

// ---- Copy (generic only) ----------------------------------------------------

export function genericCopy(kind) {
  if (kind === 'waiting_input' || kind === 'waiting_approval') {
    return { title: 'Action needed', body: 'Your task needs your input. Open the app to continue.' };
  }
  if (kind === 'completed') return { title: 'Task finished', body: 'Your task finished. Open the app to view results.' };
  if (kind === 'failed' || kind === 'cancelled') {
    return { title: 'Task update', body: 'Your task needs attention. Open the app for details.' };
  }
  return { title: 'Task update', body: 'Open the app for details.' };
}

export function kindForStatus(status) {
  if (status === 'waiting_input') return 'waiting_input';
  if (status === 'waiting_approval') return 'waiting_approval';
  if (status === 'succeeded') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return null;
}

export function eventIdFor(task) {
  return `${task.id}:${task.status}:${task.updatedAt ?? task.updated_at ?? ''}`;
}

// ---- Service ----------------------------------------------------------------

export function createNotificationService({ db, installationId, config = resolveNotificationConfig(), provider = null, store = null } = {}) {
  const cfg = config ?? { enabled: false };
  const push = provider ?? (cfg.enabled
    ? createExpoHttpProvider({ accessToken: cfg.accessToken ?? null, timeoutMs: cfg.sendTimeoutMs ?? 8000 })
    : createDisabledProvider());
  const svc = {
    db,
    installationId,
    config: cfg,
    provider: push,
    store,
    _timer: null,
    _chain: Promise.resolve(),
    _stopping: false,
    _stopped: false,
    _stopCtrl: new AbortController(),
    _runCtrl: null,
    get enabled() { return cfg.enabled === true; },
  };

  function requireEnabled() {
    if (!svc.enabled) {
      throw Object.assign(new Error('Push notifications are disabled on this home (operator opt-in required)'), { code: 'notifications_disabled' });
    }
  }

  svc.register = (session, body) => {
    requireEnabled();
    if (!session?.user_id || !session?.device_id) {
      throw Object.assign(new Error('Valid session required'), { code: 'unauthorized' });
    }
    const b = body ?? {};
    if (typeof b !== 'object' || Array.isArray(b)) {
      throw Object.assign(new Error('Invalid registration body'), { code: 'bad_request' });
    }
    for (const owned of ['user_id', 'device_id', 'installation_id']) {
      if (owned in b) throw Object.assign(new Error(`Field is home-managed: ${owned}`), { code: 'bad_request' });
    }
    const token = b.expo_push_token;
    if (!isExpoTokenFormat(token)) {
      throw Object.assign(new Error('expo_push_token must be a valid Expo push token (ExponentPushToken[...] / ExpoPushToken[...], max 256 chars)'), { code: 'invalid_push_token' });
    }
    const providerName = b.provider ?? 'expo';
    if (providerName !== 'expo') throw Object.assign(new Error('Only the expo provider is supported'), { code: 'bad_request' });
    if (typeof b.permission_enabled !== 'boolean') {
      throw Object.assign(new Error('permission_enabled must be a boolean (phone OS notification permission)'), { code: 'bad_request' });
    }
    if (b.project_id !== undefined && (typeof b.project_id !== 'string' || !b.project_id.trim() || b.project_id.length > 128)) {
      throw Object.assign(new Error('project_id must be a non-empty string up to 128 chars'), { code: 'bad_request' });
    }
    const hash = tokenHash(token);
    const now = Date.now();
    const suffix = tokenSuffix(token);
    db.exec('BEGIN IMMEDIATE');
    try {
      // Same push address on a new paired device: atomically retire the old
      // binding so a previous household user never receives this phone's alerts.
      db.prepare(
        'UPDATE push_registrations SET enabled = 0, disabled_at = ?, updated_at = ? WHERE push_token_hash = ? AND device_id != ? AND enabled = 1',
      ).run(now, now, hash, session.device_id);
      const active = db.prepare(
        'SELECT COUNT(*) AS n FROM push_registrations WHERE user_id = ? AND enabled = 1 AND device_id != ?',
      ).get(session.user_id, session.device_id).n;
      const existing = db.prepare('SELECT * FROM push_registrations WHERE device_id = ?').get(session.device_id);
      if (!existing && active >= MAX_ACTIVE_REGISTRATIONS_PER_USER) {
        db.exec('ROLLBACK');
        throw Object.assign(new Error(`Too many active push registrations (max ${MAX_ACTIVE_REGISTRATIONS_PER_USER})`), { code: 'registration_limit' });
      }
      if (existing && existing.user_id !== session.user_id) {
        db.exec('ROLLBACK');
        throw Object.assign(new Error('Device binding mismatch'), { code: 'bad_request' });
      }
      const enabledFlag = b.permission_enabled ? 1 : 0;
      if (existing) {
        db.prepare(
          `UPDATE push_registrations SET user_id = ?, push_token = ?, push_token_hash = ?, token_suffix = ?, provider = ?,
           permission_enabled = ?, enabled = ?, updated_at = ?, disabled_at = ?, fail_count = 0 WHERE device_id = ?`,
        ).run(session.user_id, String(token), hash, suffix, 'expo', enabledFlag, enabledFlag, now, enabledFlag ? null : now, session.device_id);
      } else {
        db.prepare(
          `INSERT INTO push_registrations(device_id, user_id, push_token, push_token_hash, token_suffix, provider,
           permission_enabled, enabled, created_at, updated_at, disabled_at, fail_count)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(session.device_id, session.user_id, String(token), hash, suffix, 'expo', enabledFlag, enabledFlag, now, now, enabledFlag ? null : now);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
    const row = db.prepare('SELECT * FROM push_registrations WHERE device_id = ?').get(session.device_id);
    return { registered: true, enabled: row.enabled === 1, provider: row.provider, permission_enabled: row.permission_enabled === 1 };
  };

  svc.statusFor = (session) => {
    const row = session ? db.prepare('SELECT * FROM push_registrations WHERE device_id = ?').get(session.device_id) : null;
    if (!row || row.user_id !== session?.user_id) {
      return { registered: false, enabled: false, provider: 'expo', permission_enabled: false, installation_id: installationId };
    }
    // Never return the raw token — only a non-reversible suffix for debugging.
    return {
      registered: true,
      enabled: row.enabled === 1 && svc.enabled,
      provider: row.provider,
      permission_enabled: row.permission_enabled === 1,
      token_suffix: row.token_suffix,
      created_at: row.created_at,
      updated_at: row.updated_at,
      installation_id: installationId,
    };
  };

  svc.disableForSession = (session) => {
    const now = Date.now();
    if (session?.device_id) {
      db.prepare('UPDATE push_registrations SET enabled = 0, disabled_at = ?, updated_at = ? WHERE device_id = ?')
        .run(now, now, session.device_id);
    }
    return { disabled: true };
  };

  svc.disableForDevice = (deviceId) => {
    const now = Date.now();
    db.prepare('UPDATE push_registrations SET enabled = 0, disabled_at = ?, updated_at = ? WHERE device_id = ?')
      .run(now, now, deviceId);
  };

  // Enqueue one outbox row per eligible device of the task owner. Human-wait
  // alerts (waiting_input/waiting_approval) fire for ANY owned task — a
  // delegated child asking while the phone is closed must still alert.
  // Completion/failure/cancel alerts stay root-only to suppress storms.
  // Returns the number of rows newly inserted (dedupe hits return 0 extra).
  svc.enqueueForTask = (owner, task) => {
    try {
      if (!svc.enabled) return 0;
      if (!task) return 0;
      const kind = kindForStatus(task.status);
      if (!kind || !NOTIFICATION_KINDS.has(kind)) return 0;
      if (!HUMAN_WAIT_KINDS.has(kind) && task.parentTaskId) return 0;
      const devices = db.prepare(
        `SELECT r.device_id FROM push_registrations r JOIN devices d ON d.id = r.device_id
         WHERE r.user_id = ? AND r.enabled = 1 AND r.permission_enabled = 1
           AND d.user_id = ? AND d.revoked_at IS NULL`,
      ).all(owner, owner);
      if (!devices.length) return 0;
      const conversationId = task.input?.conversationId ?? task.conversation_id ?? null;
      const eventId = eventIdFor(task);
      const now = Date.now();
      const expiryMs = cfg.expiryMs ?? 24 * 60 * 60 * 1000;
      // Bounded table: expire old rows first, then cap total pending.
      db.prepare("UPDATE notification_outbox SET status = 'dropped', updated_at = ? WHERE status = 'queued' AND expires_at <= ?").run(now, now);
      let inserted = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const d of devices) {
          const pending = db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE status = 'queued'").get().n;
          if (pending >= MAX_PENDING_OUTBOX) {
            db.prepare(
              `UPDATE notification_outbox SET status = 'dropped', last_error = 'outbox bounded: dropped oldest', updated_at = ?
               WHERE id = (SELECT id FROM notification_outbox WHERE status = 'queued' ORDER BY created_at, id LIMIT 1)`,
            ).run(now);
          }
          const id = `evt_${randomUUID()}`;
          const res = db.prepare(
            `INSERT OR IGNORE INTO notification_outbox(id, event_id, device_id, owner, task_id, conversation_id, kind, expected_status,
             status, attempts, next_attempt_at, last_error, receipt_id, created_at, updated_at, expires_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, ?, ?)`,
          ).run(id, eventId, d.device_id, owner, task.id, conversationId, kind, task.status, now, now, now, now + expiryMs);
          inserted += res.changes;
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      }
      return inserted;
    } catch (error) {
      // Enqueue is a side effect: it must never fail the settled task chain.
      console.error(`[notifications] enqueue failed: ${error?.message ?? error}`);
      return 0;
    }
  };

  // Fenced settle helpers: every write carries the lease id, so a stale
  // provider response can never mark a row claimed under a newer lease.
  // Returns true when this lease still owned the row.
  function markSentFenced(id, leaseId, receiptId, receiptPending, now) {
    const res = db.prepare(
      `UPDATE notification_outbox SET status = 'sent', receipt_id = ?, receipt_status = ?,
       next_receipt_at = ?, updated_at = ?, last_error = NULL, lease_id = NULL, lease_until = 0
       WHERE id = ? AND lease_id = ? AND status = 'sending'`,
    ).run(receiptId, receiptPending, receiptPending === 'pending' ? now + (cfg.receiptDelayMs ?? 30000) : 0, now, id, leaseId);
    return res.changes === 1;
  }

  function markDropFenced(id, leaseId, reason, now) {
    const res = db.prepare(
      `UPDATE notification_outbox SET status = 'dropped', last_error = ?, updated_at = ?,
       lease_id = NULL, lease_until = 0 WHERE id = ? AND lease_id = ? AND status = 'sending'`,
    ).run(String(reason).slice(0, 500), now, id, leaseId);
    return res.changes === 1;
  }

  function markRetryFenced(id, leaseId, attempts, reason, now) {
    const maxAttempts = cfg.maxAttempts ?? 8;
    if (attempts + 1 >= maxAttempts) {
      const res = db.prepare(
        `UPDATE notification_outbox SET status = 'dropped', attempts = ?, last_error = ?, updated_at = ?,
         lease_id = NULL, lease_until = 0 WHERE id = ? AND lease_id = ? AND status = 'sending'`,
      ).run(attempts + 1, `retries exhausted: ${String(reason).slice(0, 300)}`, now, id, leaseId);
      return res.changes === 1 ? 'dropped' : 'lost';
    }
    const base = cfg.baseDelayMs ?? 5000;
    const cap = cfg.maxDelayMs ?? 15 * 60 * 1000;
    const backoff = Math.min(cap, base * 2 ** attempts);
    const jitter = Math.floor(Math.random() * Math.min(1000, backoff));
    const res = db.prepare(
      `UPDATE notification_outbox SET status = 'queued', attempts = ?, next_attempt_at = ?, last_error = ?,
       updated_at = ?, lease_id = NULL, lease_until = 0 WHERE id = ? AND lease_id = ? AND status = 'sending'`,
    ).run(attempts + 1, now + backoff + jitter, String(reason).slice(0, 500), now, id, leaseId);
    return res.changes === 1 ? 'queued' : 'lost';
  }

  function receiptBackoffMs(attempts, now) {
    const base = Math.max(1000, cfg.receiptDelayMs ?? 30000);
    const cap = cfg.maxDelayMs ?? 15 * 60 * 1000;
    return now + Math.min(cap, base * 2 ** attempts);
  }

  async function deliverRow(id, leaseId, signal, out) {
    const row = db.prepare('SELECT * FROM notification_outbox WHERE id = ?').get(id);
    if (!row || row.status !== 'sending' || row.lease_id !== leaseId) return 'lost';
    const at = Date.now();
    // Revalidate: current active device + owner + same pending status.
    const reg = db.prepare('SELECT * FROM push_registrations WHERE device_id = ?').get(row.device_id);
    const dev = db.prepare('SELECT id, user_id, revoked_at FROM devices WHERE id = ?').get(row.device_id);
    if (!reg || reg.enabled !== 1 || reg.permission_enabled !== 1 || reg.user_id !== row.owner) {
      if (markDropFenced(row.id, leaseId, 'stale: registration inactive', at)) out.dropped += 1;
      return 'dropped';
    }
    if (!dev || dev.revoked_at != null || dev.user_id !== row.owner) {
      if (markDropFenced(row.id, leaseId, 'stale: device revoked', at)) out.dropped += 1;
      // Revoked devices must never receive again: retire the binding.
      try { svc.disableForDevice(row.device_id); } catch { /* best effort */ }
      return 'dropped';
    }
    if (svc.store) {
      let current = null;
      try {
        current = await svc.store.get(row.owner, 'tasks', row.task_id);
      } catch { current = null; }
      if (!current || current.status !== row.expected_status) {
        if (markDropFenced(row.id, leaseId, `stale: task is ${current?.status ?? 'missing'}, expected ${row.expected_status}`, at)) {
          out.dropped += 1;
        }
        return 'dropped';
      }
    }
    const copy = genericCopy(row.kind);
    const message = {
      to: reg.push_token,
      title: copy.title,
      body: copy.body,
      data: {
        installation_id: installationId,
        task_id: row.task_id,
        device_id: row.device_id,
        kind: row.kind,
        event_id: row.event_id,
      },
    };
    let tickets;
    try {
      tickets = await svc.provider.sendBatch([message], { signal });
    } catch (error) {
      const fate = markRetryFenced(row.id, leaseId, row.attempts, error?.message ?? 'send failed', Date.now());
      if (fate === 'dropped') out.dropped += 1;
      return fate;
    }
    const t = tickets?.[0];
    if (!t || t.ticketStatus !== 'ok') {
      const msg = t?.message ?? 'push rejected';
      if (isDeviceNotRegisteredTicket(t)) {
        try { svc.disableForDevice(row.device_id); } catch { /* best effort */ }
        if (markDropFenced(row.id, leaseId, `provider: ${msg}`, Date.now())) out.dropped += 1;
        return 'dropped';
      }
      const fate = markRetryFenced(row.id, leaseId, row.attempts, msg, Date.now());
      if (fate === 'dropped') out.dropped += 1;
      return fate;
    }
    // Ticket accepted: the notification is delivered. Receipts arrive late on
    // the provider side, so they are polled by a later pump — an accepted
    // notification is never resent.
    const pending = t.ticketId ? 'pending' : 'none';
    if (markSentFenced(row.id, leaseId, t.ticketId ?? null, pending, Date.now())) out.sent += 1;
    return 'sent';
  }

  // Delayed receipt sweep (bounded): at most receiptBatch rows per pump, one
  // getReceipts call. Missing receipts retry capped with expiry; terminal
  // receipt errors disable the binding for FUTURE rows. Never resends.
  async function sweepReceipts(signal, out) {
    const batch = cfg.receiptBatch ?? 50;
    const now = Date.now();
    const due = db.prepare(
      `SELECT id, receipt_id, receipt_attempts FROM notification_outbox
       WHERE status = 'sent' AND receipt_status = 'pending' AND next_receipt_at <= ?
       ORDER BY next_receipt_at, id LIMIT ?`,
    ).all(now, batch);
    if (!due.length) return;
    out.receiptsChecked = (out.receiptsChecked ?? 0) + due.length;
    const maxAttempts = cfg.receiptMaxAttempts ?? 10;
    const ids = [...new Set(due.map((r) => r.receipt_id).filter((id) => typeof id === 'string' && id))];
    let map = null;
    try {
      map = ids.length ? await svc.provider.getReceipts(ids.slice(0, MAX_RECEIPT_IDS_PER_CALL), { signal }) : {};
      if (!map || typeof map !== 'object') throw new Error('Unexpected receipt response shape');
    } catch (error) {
      const retryAt = receiptBackoffMs(0, Date.now());
      for (const row of due) {
        const attempts = (row.receipt_attempts ?? 0) + 1;
        const terminal = attempts >= maxAttempts;
        db.prepare(
          `UPDATE notification_outbox SET receipt_status = ?, receipt_attempts = ?, next_receipt_at = ?, updated_at = ?
           WHERE id = ? AND status = 'sent' AND receipt_status = 'pending'`,
        ).run(terminal ? 'error' : 'pending', attempts, terminal ? 0 : retryAt, Date.now(), row.id);
      }
      out.receiptPollError = String(error?.message ?? error).slice(0, 200);
      return;
    }
    for (const row of due) {
      const r = map?.[row.receipt_id];
      const stamp = Date.now();
      if (!r) {
        // Provider has no receipt yet (too early): bounded retry, never resend.
        const attempts = (row.receipt_attempts ?? 0) + 1;
        const terminal = attempts >= maxAttempts;
        db.prepare(
          `UPDATE notification_outbox SET receipt_status = ?, receipt_attempts = ?, next_receipt_at = ?, updated_at = ?
           WHERE id = ? AND status = 'sent' AND receipt_status = 'pending'`,
        ).run(terminal ? 'error' : 'pending', attempts, terminal ? 0 : receiptBackoffMs(attempts, stamp), stamp, row.id);
        continue;
      }
      if (r.status === 'ok') {
        db.prepare(
          `UPDATE notification_outbox SET receipt_status = 'ok', updated_at = ?
           WHERE id = ? AND status = 'sent' AND receipt_status = 'pending'`,
        ).run(stamp, row.id);
        continue;
      }
      if (r.status === 'error' && isDeviceNotRegisteredReceipt(r)) {
        try { svc.disableForDevice(db.prepare('SELECT device_id FROM notification_outbox WHERE id = ?').get(row.id)?.device_id); } catch { /* best effort */ }
        db.prepare(
          `UPDATE notification_outbox SET receipt_status = 'error', updated_at = ?
           WHERE id = ? AND status = 'sent' AND receipt_status = 'pending'`,
        ).run(stamp, row.id);
        continue;
      }
      // Other provider errors: bounded retry, then give up (row stays sent).
      const attempts = (row.receipt_attempts ?? 0) + 1;
      const terminal = attempts >= maxAttempts;
      db.prepare(
        `UPDATE notification_outbox SET receipt_status = ?, receipt_attempts = ?, next_receipt_at = ?, updated_at = ?
         WHERE id = ? AND status = 'sent' AND receipt_status = 'pending'`,
      ).run(terminal ? 'error' : 'pending', attempts, terminal ? 0 : receiptBackoffMs(attempts, stamp), stamp, row.id);
    }
  }

  // Bounded retention for transient outbox rows (sent/dropped): keeps the
  // table small without touching task history (records/messages/artifacts).
  function pruneOutbox(now) {
    const retentionMs = cfg.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    const maxRows = cfg.outboxMaxRows ?? MAX_OUTBOX_ROWS;
    try {
      db.prepare(
        `DELETE FROM notification_outbox WHERE id IN (
           SELECT id FROM notification_outbox
           WHERE status IN ('sent', 'dropped') AND updated_at < ?
           ORDER BY updated_at LIMIT 500)`,
      ).run(now - retentionMs);
    } catch { /* pruning is best effort */ }
    try {
      const total = db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n;
      if (total > maxRows) {
        db.prepare(
          `DELETE FROM notification_outbox WHERE id IN (
             SELECT id FROM notification_outbox
             WHERE status IN ('sent', 'dropped')
             ORDER BY updated_at ASC LIMIT ?)`,
        ).run(total - maxRows);
      }
    } catch { /* pruning is best effort */ }
  }

  async function runPump() {
    const out = { sent: 0, dropped: 0, pending: 0, receiptsChecked: 0 };
    if (!svc.enabled) return { ...out, skipped: true };
    if (svc._stopped) return { ...out, skipped: true };
    const now = Date.now();
    // Crash recovery: rows left 'sending' by a dead pump (expired lease)
    // go back to queued; at-least-once delivery stays honest via stable
    // event IDs the phone dedupes on.
    try {
      db.prepare(
        "UPDATE notification_outbox SET status = 'queued', lease_id = NULL, lease_until = 0, updated_at = ? WHERE status = 'sending' AND lease_until <= ?",
      ).run(now, now);
    } catch (error) {
      return { ...out, error: String(error?.message ?? error).slice(0, 200) };
    }
    pruneOutbox(now);
    const batchSize = cfg.batchSize ?? 10;
    let due = [];
    try {
      due = db.prepare(
        "SELECT id FROM notification_outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY created_at, id LIMIT ?",
      ).all(now, batchSize);
    } catch (error) {
      return { ...out, error: String(error?.message ?? error).slice(0, 200) };
    }
    // Durable claim: exactly one pumper (even across processes on one DB)
    // moves a row queued -> sending under its lease id.
    const leaseId = `lease_${randomUUID()}`;
    const leaseUntil = Date.now() + (cfg.leaseMs ?? 60000);
    const claimed = [];
    for (const row of due) {
      try {
        const res = db.prepare(
          "UPDATE notification_outbox SET status = 'sending', lease_id = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
        ).run(leaseId, leaseUntil, Date.now(), row.id);
        if (res.changes === 1) claimed.push(row.id);
      } catch { /* CAS lost or DB busy: skip this row */ }
    }
    // Per-run abort: stop() aborts in-flight provider calls; the timeout in
    // the provider bounds every call anyway.
    const runCtrl = new AbortController();
    svc._runCtrl = runCtrl;
    const onStop = () => {
      try { runCtrl.abort(svc._stopCtrl.signal.reason ?? new Error('notifications stopping')); } catch { /* best effort */ }
    };
    if (svc._stopping || svc._stopCtrl.signal.aborted) {
      try { runCtrl.abort(new Error('notifications stopping')); } catch { /* best effort */ }
    } else {
      svc._stopCtrl.signal.addEventListener('abort', onStop, { once: true });
    }
    try {
      for (const id of claimed) {
        if (svc._stopping || runCtrl.signal.aborted) break;
        try {
          await deliverRow(id, leaseId, runCtrl.signal, out);
        } catch (error) {
          console.error(`[notifications] deliver failed: ${error?.message ?? error}`);
        }
      }
      if (!svc._stopping && !runCtrl.signal.aborted) {
        try {
          await sweepReceipts(runCtrl.signal, out);
        } catch (error) {
          console.error(`[notifications] receipt sweep failed: ${error?.message ?? error}`);
        }
      }
    } finally {
      try { svc._stopCtrl.signal.removeEventListener('abort', onStop); } catch { /* best effort */ }
      if (svc._runCtrl === runCtrl) svc._runCtrl = null;
    }
    try {
      out.pending = db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE status = 'queued'").get().n;
    } catch { /* DB may be closing */ }
    return out;
  }

  // Serialized pumps (single-flight per service): overlapping calls chain
  // instead of interleaving sends. Cross-process overlap is fenced by the
  // durable CAS claim above. Never throws.
  svc.pump = () => {
    const run = svc._chain.then(() => runPump(), () => runPump());
    // Keep the chain alive across unexpected rejections (runPump catches its
    // own, but never let a rejection wedge future pumps).
    svc._chain = run.catch(() => {});
    return run;
  };

  svc.start = () => {
    if (svc._timer || !svc.enabled) return;
    svc._stopping = false;
    svc._stopped = false;
    const ms = cfg.pumpIntervalMs ?? 15000;
    svc._timer = setInterval(() => {
      svc.pump().catch((e) => console.error(`[notifications] pump failed: ${e?.message ?? e}`));
    }, ms);
    if (svc._timer.unref) svc._timer.unref();
  };

  svc.stop = async () => {
    if (svc._timer) {
      clearInterval(svc._timer);
      svc._timer = null;
    }
    // Bounded stop: abort in-flight sends, then await the serialized pump so
    // no provider callback can write after the DB closes. Stale responses are
    // fenced by lease id and cannot mark rows claimed under a newer lease.
    svc._stopping = true;
    try { svc._stopCtrl.abort(new Error('notifications stopping')); } catch { /* best effort */ }
    try { svc._runCtrl?.abort(new Error('notifications stopping')); } catch { /* best effort */ }
    try { await svc._chain; } catch { /* best effort */ }
    svc._stopped = true;
  };

  return svc;
}

export function ensureNotificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_registrations (
      device_id TEXT PRIMARY KEY REFERENCES devices(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      push_token TEXT NOT NULL,
      push_token_hash BLOB NOT NULL,
      token_suffix TEXT NOT NULL,
      provider TEXT NOT NULL,
      permission_enabled INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      disabled_at INTEGER,
      fail_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_push_reg_token ON push_registrations(push_token_hash);
    CREATE INDEX IF NOT EXISTS idx_push_reg_user ON push_registrations(user_id, enabled);
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      task_id TEXT NOT NULL,
      conversation_id TEXT,
      kind TEXT NOT NULL,
      expected_status TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      receipt_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      lease_id TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0,
      receipt_status TEXT,
      next_receipt_at INTEGER NOT NULL DEFAULT 0,
      receipt_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_event_device ON notification_outbox(event_id, device_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON notification_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_task ON notification_outbox(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_outbox_receipt ON notification_outbox(status, receipt_status, next_receipt_at);
  `);
}
