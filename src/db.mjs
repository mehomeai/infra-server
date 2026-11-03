import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 5;

// Home store (H2). SQLite via Node's built-in node:sqlite only (no extra
// dependencies). All secrets are stored as SHA-256 hashes; raw secrets never
// touch these tables. Times are milliseconds since the Unix epoch unless a
// field is documented as ISO-8601 text.
//
// Privacy: the data directory is mode 0700 and database files 0600. Foreign
// keys are enforced on every connection. schema_version gates startup: newer
// than supported refuses to open; version 1 migrates forward in place.
export function openHomeDb(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    /* best effort on unfamiliar filesystems */
  }
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      secret_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_invitations_user ON invitations(user_id);
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      label TEXT NOT NULL,
      secret_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash BLOB PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_id, updated_at);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      author_user_id TEXT NOT NULL REFERENCES users(id),
      author_device_id TEXT REFERENCES devices(id),
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      request_key TEXT,
      task_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at, id);
    -- Exactly-once publication of task output: at most one assistant message
    -- per task. request_key keys client retries; task_id keys home publication.
    -- (Partial index is created in migrate(), after old databases gain task_id.)
  `);
  // Generic worker-managed records (tasks, run-events, runs, actions) for the
  // reused upstream TaskWorker. Product tables above stay relational.
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(owner, kind, id)
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      task_id TEXT NOT NULL,
      name TEXT NOT NULL,
      bytes BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(owner_id, task_id, created_at);
  `);
  migrate(db);
  for (const suffix of ['', '-wal', '-shm']) {
    const file = suffix ? `${path}${suffix}` : path;
    if (existsSync(file)) {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best effort */
      }
    }
  }
  let installationId = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('installation_id')?.value;
  if (!installationId) {
    installationId = randomUUID();
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
      'installation_id',
      installationId,
    );
  }
  return { db, installationId };
}

function migrate(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = row ? Number(row.value) : null;
  if (version !== null && Number.isInteger(version) && version > SCHEMA_VERSION) {
    throw new Error(
      `Unsupported home database schema_version ${version} (this build supports ${SCHEMA_VERSION}); refusing to open`,
    );
  }
  const from = version ?? (hasV1Tables(db) ? 1 : 0);
  if (from <= 2) {
    const cols = db.prepare('PRAGMA table_info(messages)').all();
    if (!cols.some((c) => c.name === 'request_key')) {
      db.exec('ALTER TABLE messages ADD COLUMN request_key TEXT');
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_request_key
        ON messages(conversation_id, author_user_id, request_key);
    `);
  }
  // task_id backfill (v3) runs for every database whose version predates it,
  // including fresh databases whose CREATE TABLE already carries the column.
  {
    const cols = db.prepare('PRAGMA table_info(messages)').all();
    if (!cols.some((c) => c.name === 'task_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN task_id TEXT');
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_assistant_once
        ON messages(task_id) WHERE task_id IS NOT NULL;
    `);
  }
  // Opt-in push registrations + notification outbox (v4, H7). Fresh databases
  // create both tables; v3 databases gain them in place. No private content
  // is stored here — only metadata (ids/kind/event) plus the push address.
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
  // H7.1 durable delivery lease + delayed receipt polling (v5). v4 databases
  // gain the columns in place; fresh databases already carry them above.
  {
    const cols = new Set(db.prepare('PRAGMA table_info(notification_outbox)').all().map((c) => c.name));
    for (const [name, ddl] of [
      ['lease_id', 'ALTER TABLE notification_outbox ADD COLUMN lease_id TEXT'],
      ['lease_until', 'ALTER TABLE notification_outbox ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0'],
      ['receipt_status', 'ALTER TABLE notification_outbox ADD COLUMN receipt_status TEXT'],
      ['next_receipt_at', 'ALTER TABLE notification_outbox ADD COLUMN next_receipt_at INTEGER NOT NULL DEFAULT 0'],
      ['receipt_attempts', 'ALTER TABLE notification_outbox ADD COLUMN receipt_attempts INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!cols.has(name)) db.exec(ddl);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_receipt ON notification_outbox(status, receipt_status, next_receipt_at)`);
  }
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', String(SCHEMA_VERSION));
}

function hasV1Tables(db) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();
  return Boolean(row);
}

export function closeHomeDb(handle) {
  handle.db.close();
}
