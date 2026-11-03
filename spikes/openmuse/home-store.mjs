import { DatabaseSync } from 'node:sqlite';

// Integration fixture only. This implements the small Store interface consumed
// by the unchanged upstream worker using Node's built-in SQLite. It is not our
// selected production schema, household authorization service, or model memory.
export class HomeStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        data TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner,kind,id)
      );
    `);
  }
  async get(owner, kind, id) {
    const row = this.db.prepare('SELECT data FROM records WHERE owner=? AND kind=? AND id=?')
      .get(owner, kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  async put(owner, kind, value) {
    this.db.prepare(`INSERT INTO records VALUES(?,?,?,?,?)
      ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
      .run(owner, kind, value.id, JSON.stringify(value), Date.now());
    return structuredClone(value);
  }
  async scan(kind) {
    return this.db.prepare('SELECT owner,data FROM records WHERE kind=? ORDER BY updated_at,id')
      .all(kind).map(row => ({ owner: row.owner, value: JSON.parse(row.data) }));
  }
  async list(owner, kind) {
    return this.db.prepare('SELECT data FROM records WHERE owner=? AND kind=? ORDER BY updated_at,id')
      .all(owner, kind).map(row => JSON.parse(row.data));
  }
  async compareAndSwap(owner, kind, id, expected, patch) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT data FROM records WHERE owner=? AND kind=? AND id=?')
        .get(owner, kind, id);
      const value = row ? JSON.parse(row.data) : null;
      // Match the upstream worker's flat expected-field contract. JSON null is
      // significant: absent fields do not satisfy an expected null.
      const matches = value && Object.entries(expected).every(([key, wanted]) =>
        Object.hasOwn(value, key) && JSON.stringify(value[key]) === JSON.stringify(wanted));
      let next = null;
      if (matches) {
        next = { ...value, ...patch };
        this.db.prepare('UPDATE records SET data=?,updated_at=? WHERE owner=? AND kind=? AND id=?')
          .run(JSON.stringify(next), Date.now(), owner, kind, id);
      }
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async close() { this.db.close(); }
}
