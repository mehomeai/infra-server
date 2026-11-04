#!/usr/bin/env node
// Documented CLI / importable lifecycle for cross-repo integration.
// Default bind is loopback only. Fixture users below are DEVELOPMENT ONLY.
// Note: run with Node's type-stripping for the vendored worker import:
//   node --experimental-transform-types src/cli.mjs <command>
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHomeServer, DEFAULT_HOST, DEFAULT_PORT, ensureUser } from './server.mjs';
import { createInvitation, INVITATION_TTL_MS } from './server.mjs';
import { openHomeDb, closeHomeDb } from './db.mjs';

function flag(name, fallback = null) {
  const hit = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

function usage() {
  console.log(`me-home usage:
  node --experimental-transform-types src/cli.mjs start [--db=<path>] [--host=127.0.0.1] [--port=7070]
  node --experimental-transform-types src/cli.mjs bootstrap --user=<id> [--db=<path>] [--ttl-ms=900000] [--name=<display>]
  node --experimental-transform-types src/cli.mjs seed-dev [--db=<path>]
  node --experimental-transform-types src/cli.mjs upstream-doctor [--no-probe]

start binds loopback (${DEFAULT_HOST}) by default. bootstrap/seed-dev touch the
SQLite file directly on this host; they never traverse the network.
seed-dev creates DEVELOPMENT-ONLY fixture users alice/bob for local tests.

Task execution env (see docs/home-h2-handoff.md):
  HOME_MODEL_PROVIDER=local|fixture|openai|anthropic (required for task runs)
  HOME_ALLOW_FIXTURE_MODEL=1 (fixture only, dev/tests)
  ME_RUNTIME_CMD="python3 -m me_runtime.bridge" (default; tests use the fixture bridge)`);
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parsePort(raw, fallback) {
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw)) die(`--port must be an integer 1..65535 (got ${JSON.stringify(raw)})`);
  const port = Number(raw);
  if (port < 1 || port > 65535) die(`--port must be an integer 1..65535 (got ${raw})`);
  return port;
}

function parseTtlMs(raw, fallback) {
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw)) die(`--ttl-ms must be a positive integer of milliseconds (got ${JSON.stringify(raw)})`);
  const ttl = Number(raw);
  if (ttl <= 0 || ttl > 24 * 60 * 60 * 1000) die('--ttl-ms must be within 1ms..24h');
  return ttl;
}

function parseUser(raw) {
  if (raw == null || raw === '') die('bootstrap requires --user=<id>');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) die('--user must be 1..128 chars of letters, digits, . _ -');
  return raw;
}

const command = process.argv[2];
const dbPath = resolve(flag('--db', process.env.HOME_DB ?? 'data/home.sqlite'));

if (command === 'start') {
  const host = flag('--host', process.env.HOME_HOST ?? DEFAULT_HOST);
  const port = parsePort(flag('--port', process.env.HOME_PORT ?? String(DEFAULT_PORT)), DEFAULT_PORT);
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    console.error(`WARNING: binding non-loopback host ${host}; intended for tunneled/protected deployment only.`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const server = createHomeServer({ dbPath });
  await server.start({ host, port });
  const addr = `http://${host}:${port}`;
  console.log(`home-api-v1 listening on ${addr} (db ${dbPath})`);
  console.log(`installation ${server.installationId}`);
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (command === 'bootstrap') {
  const user = parseUser(flag('--user', null));
  const ttlMs = parseTtlMs(flag('--ttl-ms', null), INVITATION_TTL_MS);
  const name = String(flag('--name', user)).slice(0, 200);
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = openHomeDb(dbPath);
  try {
    ensureUser(handle.db, user, name);
    const inv = createInvitation(handle.db, user, ttlMs);
    // Secret is printed once so the local operator can QR/show it to the phone.
    console.log(JSON.stringify({
      installation_id: handle.installationId,
      user_id: user,
      ...inv,
    }));
  } finally {
    closeHomeDb(handle);
  }
} else if (command === 'seed-dev') {
  // DEVELOPMENT ONLY: predictable local fixture users for integration tests.
  // Not production identity; real account/household checks live elsewhere.
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = openHomeDb(dbPath);
  try {
    for (const u of ['alice', 'bob']) ensureUser(handle.db, u, `${u} (dev fixture)`);
    console.log(JSON.stringify({
      installation_id: handle.installationId,
      users: ['alice', 'bob'],
      warning: 'DEVELOPMENT-ONLY fixture users; not production identity',
    }));
  } finally {
    closeHomeDb(handle);
  }
} else if (command === 'upstream-doctor') {
  const { checkUpstreamPlatform, writeDoctorCache } = await import('./upstream-doctor.mjs');
  const { writeFileSync } = await import('node:fs');
  const probe = !process.argv.includes('--no-probe');
  const cache = flag('--cache', null);
  const report = await checkUpstreamPlatform({ probe });
  if (cache) {
    // Bounded live evidence for the home server capability report
    // (data-dir owned file; server trusts it only when fresh + READY).
    writeDoctorCache(cache, report, { fs: { writeFileSync } });
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.state === 'FAILED' ? 1 : 0);
} else {
  usage();
  process.exit(command ? 1 : 0);
}
