// Verified Me ht1 -> upstream BetterAuth identity hook (FULL primary).
//
// Upstream has NO such exchange (audited: IdentifyUser/IdentifyActor are
// injectable in mountCopilotRuntime + createRequestActor, but no ht1 bridge
// exists). This module IS the verified extension point: home validates its
// existing opaque ht1_* sessions server-side, maps 1:1 to an upstream user,
// persists the trusted record in the home DB (non-destructive lazy table),
// and supplies identifyUser/identifyActor for the upstream mounting layer.
//
// Rules: never shared admin/dev-local-user, never body user_id trust, owner
// role configured locally (ME_UPSTREAM_ADMIN_USERS), never arbitrary first
// visitor. Upstream policies/auth checks stay intact.

import { checkUpstreamId } from './upstream-computer.mjs';

export function ensureUpstreamTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS upstream_users (
      me_user_id TEXT PRIMARY KEY REFERENCES users(id),
      upstream_user_id TEXT NOT NULL UNIQUE,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS upstream_threads (
      home_conversation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      deployment_id TEXT NOT NULL,
      me_user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
  `);
}

function adminSet(env = process.env) {
  const raw = String(env.ME_UPSTREAM_ADMIN_USERS ?? env.INITIAL_ADMIN_EMAILS ?? '');
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function isUpstreamAdmin(meUserId, email, env = process.env) {
  const admins = adminSet(env);
  if (admins.has(String(meUserId).toLowerCase())) return true;
  if (email && admins.has(String(email).toLowerCase())) return true;
  return false;
}

export function getUpstreamUser(db, meUserId) {
  ensureUpstreamTables(db);
  return db.prepare('SELECT me_user_id, upstream_user_id, email, role FROM upstream_users WHERE me_user_id = ?').get(meUserId) ?? null;
}

// Server-side only. Caller MUST have validated the Me session (ht1_*) first;
// this function maps the validated owner, never a client-supplied id.
export function ensureUpstreamUser(db, meUserId, { upstreamUserId, email = null, env = process.env } = {}) {
  ensureUpstreamTables(db);
  const owner = db.prepare('SELECT id FROM users WHERE id = ?').get(meUserId);
  if (!owner) throw Object.assign(new Error(`Unknown user: ${meUserId}`), { code: 'not_found' });
  const mapped = checkUpstreamId(upstreamUserId ?? `u_${String(meUserId).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64), 'upstream user');
  const role = isUpstreamAdmin(meUserId, email, env) ? 'admin' : 'user';
  const now = Date.now();
  db.prepare(`
    INSERT INTO upstream_users(me_user_id, upstream_user_id, email, role, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(me_user_id) DO UPDATE SET upstream_user_id=excluded.upstream_user_id, email=excluded.email, role=excluded.role, updated_at=excluded.updated_at
  `).run(meUserId, mapped, email, role, now, now);
  return { me_user_id: meUserId, upstream_user_id: mapped, email, role };
}

// IdentifyUser injection for mountCopilotRuntime: {id, name} scoped threads.
export function identifyUpstreamUserForSession(db, session) {
  if (!session?.user_id) throw Object.assign(new Error('A CopilotKit run requires a signed-in user.'), { code: 'unauthorized' });
  const row = getUpstreamUser(db, session.user_id);
  if (!row) throw Object.assign(new Error('Upstream identity not linked for this owner (server-side exchange required).'), { code: 'upstream_not_linked' });
  return { id: row.upstream_user_id, name: session.user_id };
}

// IdentifyActor injection: {id, role} for agent visibility. Anonymous on
// failure (mirrors upstream ANONYMOUS_ACTOR), never throws into runtime.
export function identifyUpstreamActorForSession(db, session) {
  try {
    const row = session?.user_id ? getUpstreamUser(db, session.user_id) : null;
    if (!row) return { id: '', role: 'user' };
    return { id: row.upstream_user_id, role: row.role === 'admin' ? 'admin' : 'user' };
  } catch {
    return { id: '', role: 'user' };
  }
}
