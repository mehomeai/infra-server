// Production Store adapter for the reused upstream TaskWorker over the home
// SQLite database. Same compare-and-swap semantics as the spike fixture:
// every expected field must be present on the stored value and deeply equal.
export class WorkerStore {
  constructor(db) {
    this.db = db;
  }
  async get(owner, kind, id) {
    const row = this.db
      .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?')
      .get(owner, kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  async put(owner, kind, value) {
    this.db
      .prepare(
        `INSERT INTO records(owner, kind, id, data, updated_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(owner, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(owner, kind, value.id, JSON.stringify(value), Date.now());
    return structuredClone(value);
  }
  async scan(kind) {
    return this.db
      .prepare('SELECT owner, data FROM records WHERE kind = ? ORDER BY updated_at, id')
      .all(kind)
      .map((row) => ({ owner: row.owner, value: JSON.parse(row.data) }));
  }
  async list(owner, kind) {
    return this.db
      .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? ORDER BY updated_at, id')
      .all(owner, kind)
      .map((row) => JSON.parse(row.data));
  }
  async compareAndSwap(owner, kind, id, expected, patch) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT data FROM records WHERE owner = ? AND kind = ? AND id = ?')
        .get(owner, kind, id);
      const value = row ? JSON.parse(row.data) : null;
      const matches =
        value &&
        Object.entries(expected).every(
          ([key, wanted]) =>
            Object.hasOwn(value, key) && JSON.stringify(value[key]) === JSON.stringify(wanted),
        );
      let next = null;
      if (matches) {
        next = { ...value, ...patch };
        this.db
          .prepare('UPDATE records SET data = ?, updated_at = ? WHERE owner = ? AND kind = ? AND id = ?')
          .run(JSON.stringify(next), Date.now(), owner, kind, id);
      }
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }
}
