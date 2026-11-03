// READ-ONLY cross-repo native transport acceptance (model-free).
// Owned by infra-server (scripts/acceptance-native.mjs). Never edits repos,
// never commits, never calls outside services.
//
// Ported faithfully from the independent E audit script (25 model-free cases,
// same assertions, same fixture semantics). ONLY the following are adapted:
// sibling-root resolution (ME_ROOT env, default = repo parent) and the output
// dir (NATIVE_ACCEPT_OUT_DIR env, default = the audit-native handoff dir).
// The home server, phone client/controller and upstream modules under test
// are imported REAL (no reconstructions, no helpers).
//
// What runs (all actual modules, no reconstructions):
//   phone  PairedHomeClient (phone-app/src/paired-home-client.ts)
//   phone  UpstreamNativeClient + NativeConversationController
//          (phone-app/src/upstream-native.ts, upstream-conversation.ts)
//   home   actual Me home HTTP server + SQLite (infra-server/src/server.mjs)
//          in ME_UPSTREAM_MODE=full, proxying to the loopback fixture below
//   bridge ACTUAL verifyHomeAssertion (infra-server/src/upstream-proxy.mjs)
//          used by the fixture to gate, mirroring vendor home-bridge semantics
//
// Fixture = explicitly labeled loopback native REST stand-in. It speaks ONLY
// the pinned native HTTP protocol (CopilotKit/OpenBot pin 6bfee78 routes/DTOs
// per mobile/src/api.ts, mobile/app/conversation.tsx, approvals.tsx,
// server/src/delivery/routes.ts, server/src/channels/routes.ts,
// server/src/tasks/routes.ts). It is NOT Intelligence, NOT a model, NOT the
// upstream engine: assistant replies are canned hydration strings scheduled
// on a timer, labeled FIXTURE-PROTOCOL-ONLY in every response header.
//
// Transport tests explicitly bypass product READY gating in this TEST harness
// (no doctor cache is written; /healthz fullConfigured stays false) and NEVER
// claim production readiness.
//
// Rerun (from infra-server/):
//   node --experimental-transform-types --disable-warning=ExperimentalWarning \
//     scripts/acceptance-native.mjs
//   ME_ROOT=/path/to/me NATIVE_ACCEPT_OUT_DIR=/tmp/out node ... scripts/acceptance-native.mjs
//
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = pathDirname(pathDirname(fileURLToPath(import.meta.url)));
const ME = process.env.ME_ROOT ?? pathDirname(REPO_ROOT);
const OUT_DIR = process.env.NATIVE_ACCEPT_OUT_DIR ?? '/private/tmp/me-upstream-migration-20261103/audit-native';

const { createHomeServer, ensureUser, createInvitation } = await import(
  `${ME}/infra-server/src/server.mjs`
);
const { verifyHomeAssertion } = await import(
  `${ME}/infra-server/src/upstream-proxy.mjs`
);
const { PairedHomeClient } = await import(
  `${ME}/phone-app/src/paired-home-client.ts`
);
const { UpstreamNativeClient } = await import(
  `${ME}/phone-app/src/upstream-native.ts`
);
const { NativeConversationController } = await import(
  `${ME}/phone-app/src/upstream-conversation.ts`
);

const BRIDGE_SECRET = 'audit-native-fixture-bridge-secret-0123456789abcdef';
const FIXTURE_LABEL = 'FIXTURE-PROTOCOL-ONLY; not Intelligence/model/engine';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 500) });
  process.stderr.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}\n`);
}

function memStore() {
  const m = new Map();
  return {
    getItem: async (k) => (m.has(k) ? m.get(k) : null),
    setItem: async (k, v) => void m.set(k, String(v)),
    deleteItem: async (k) => void m.delete(k),
  };
}
function makePhone(homeBaseUrl) {
  void homeBaseUrl;
  const secure = memStore();
  const phone = new PairedHomeClient(secure, memStore(), {
    allowInsecureLoopback: true,
    requestTimeoutMs: 8000,
  });
  return { phone, secure };
}
const nativeTransportFor = (client) => ({
  request: (path, init) =>
    client.proxyNativeApi(path, { method: init.method, body: init.body }),
});

// ---- Labeled loopback native REST fixture (protocol only) ----
function createNativeFixture() {
  const channels = new Map(); // id -> {id,name,agentIds,active,owner,historyShape}
  const transcripts = new Map(); // id -> [{id,role,content}]
  const seenByExternalId = new Map(); // externalId -> {channelId, bodyHash}
  const calls = []; // {method,path,owner,role,hadPhoneCreds,forgedSeen}
  let n = 0;
  const timers = new Set();

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        if (!parts.length) return resolve(undefined);
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  const send = (res, status, body) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-fixture': FIXTURE_LABEL,
    });
    res.end(text);
  };

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const headers = req.headers;
    const hadPhoneCreds = Boolean(headers.authorization || headers.cookie);
    const assertion = headers['x-me-home-assertion'];
    const verified = verifyHomeAssertion(
      Array.isArray(assertion) ? assertion[0] : assertion,
      { bridgeSecret: BRIDGE_SECRET },
    );
    const owner = verified?.upstreamUserId ?? null;
    calls.push({
      method,
      path,
      owner,
      role: verified?.role ?? null,
      hadPhoneCreds,
      forgedSeen: typeof assertion === 'string' && !verified,
    });
    if (hadPhoneCreds) return send(res, 401, { error: 'phone credentials must never reach upstream' });
    if (!verified) return send(res, 401, { error: 'invalid or missing home assertion' });

    if (method === 'GET' && path === '/api/agents') {
      return send(res, 200, {
        agents: [{ id: 'bot_main', name: 'Main Bot', mine: true, canManage: false }],
      });
    }
    if (method === 'POST' && path === '/api/channels/') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'Supply a valid request.' });
      }
      if (!Array.isArray(body?.agentIds) || body.agentIds.length === 0 || body.agentIds.some((a) => a !== 'bot_main')) {
        return send(res, 400, { error: 'Supply a valid request.' });
      }
      const id = `ch_${++n}_${owner}`;
      const channel = { id, name: 'Chat', agentIds: body.agentIds, active: true };
      // Alternate the two REAL history shapes per channel (conversation.tsx:58-60):
      // odd channels -> {history: [...]}, even channels -> {history: {messages: [...]}}.
      channels.set(id, { ...channel, owner, historyShape: n % 2 === 0 ? 'envelope' : 'array' });
      transcripts.set(id, []);
      return send(res, 201, { channel });
    }
    if (method === 'GET' && path === '/api/channels/') {
      const owned = [...channels.values()].filter((c) => c.owner === owner)
        .map(({ owner: _o, historyShape: _h, ...c }) => c);
      return send(res, 200, { channels: owned, nextCursor: null });
    }
    const chGet = path.match(/^\/api\/channels\/([^/]+)$/);
    if (method === 'GET' && chGet) {
      const c = channels.get(chGet[1]);
      if (!c || c.owner !== owner) return send(res, 404, { error: "Couldn't find that conversation." });
      const { owner: _o, historyShape: _h, ...rest } = c;
      return send(res, 200, { channel: rest });
    }
    if (method === 'GET' && path === '/api/delivery/conversations') {
      const owned = [...channels.values()].filter((c) => c.owner === owner)
        .map(({ owner: _o, historyShape: _h, ...c }) => c);
      return send(res, 200, { conversations: owned, nextCursor: null });
    }
    const hist = path.match(/^\/api\/delivery\/conversations\/([^/]+)\/history$/);
    if (method === 'GET' && hist) {
      const c = channels.get(hist[1]);
      const agentId = u.searchParams.get('agentId');
      if (!c || c.owner !== owner || !c.agentIds.includes(agentId)) {
        return send(res, 400, { error: 'Choose an accessible Bot in your conversation.' });
      }
      const t = transcripts.get(hist[1]) ?? [];
      if (c.historyShape === 'envelope') return send(res, 200, { history: { messages: t } });
      return send(res, 200, { history: t });
    }
    const msg = path.match(/^\/api\/delivery\/conversations\/([^/]+)\/messages$/);
    if (method === 'POST' && msg) {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'Supply a valid request.' });
      }
      const c = channels.get(msg[1]);
      const uuidOk = UUID_RE.test(String(body?.externalId ?? ''));
      if (!c || c.owner !== owner || body?.agentId == null || !c.agentIds.includes(body.agentId)) {
        return send(res, 400, { error: 'Choose an accessible Bot in your conversation.' });
      }
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000 || !uuidOk) {
        return send(res, 400, { error: 'Supply a valid request.' });
      }
      const t = transcripts.get(msg[1]);
      const prior = seenByExternalId.get(body.externalId);
      const hash = createHash('sha256').update(`${body.agentId}\n${body.text}`).digest('hex');
      if (prior && prior.channelId === msg[1] && prior.bodyHash === hash) {
        // Idempotent retry: same UUID + byte-identical body -> 202, no duplicate.
        return send(res, 202, { accepted: true, externalId: body.externalId, duplicate: true });
      }
      if (prior && prior.channelId === msg[1]) {
        // Fixture-only conflict policy (NOT claimed upstream behavior).
        return send(res, 409, { error: 'fixture: externalId reused with different body' });
      }
      seenByExternalId.set(body.externalId, { channelId: msg[1], bodyHash: hash });
      t.push({ id: `m_${t.length + 1}`, role: 'user', content: body.text });
      // Canned hydration (labeled fixture behavior, not a model): an assistant
      // reply lands shortly after, exercising phone 202-then-poll.
      const timer = setTimeout(() => {
        timers.delete(timer);
        t.push({ id: `m_${t.length + 1}`, role: 'assistant', content: `hydrated reply to: ${body.text.slice(0, 80)}` });
      }, 250);
      timers.add(timer);
      return send(res, 202, { accepted: true, externalId: body.externalId });
    }
    if (method === 'GET' && path === '/api/approvals') {
      return send(res, 200, {
        requests: [
          {
            id: 'apr_1',
            botId: 'bot_main',
            toolRef: 'calendar.read',
            status: 'pending',
            effect: 'read',
            scope: 'calendar',
            preview: { when: 'tomorrow' },
          },
        ],
        questions: [{ id: 'q_1', question: 'Which day?', botId: 'bot_main' }],
      });
    }
    const dec = path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (method === 'POST' && dec) {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'Supply a valid request.' });
      }
      if (!['allow_once', 'allow_always', 'deny'].includes(body?.decision)) {
        return send(res, 400, { error: 'Supply a valid request.' });
      }
      return send(res, 200, { ok: true });
    }
    const q = path.match(/^\/api\/approvals\/questions\/([^/]+)\/respond$/);
    if (method === 'POST' && q) {
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/tasks') {
      const owned = [...channels.values()].filter((c) => c.owner === owner);
      return send(res, 200, {
        tasks: owned.map((c) => ({
          id: `task_${c.id}`,
          agentId: 'bot_main',
          channelId: c.id,
          title: 'Task',
          status: 'working',
          failure: null,
          next: 'last line',
          updatedAt: new Date().toISOString(),
        })),
      });
    }
    const taskGet = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskGet) {
      const chId = String(taskGet[1]).replace(/^task_/, '');
      const c = channels.get(chId);
      if (!c || c.owner !== owner) return send(res, 404, { error: 'not found' });
      return send(res, 200, {
        task: {
          id: taskGet[1],
          agentId: 'bot_main',
          channelId: chId,
          title: 'Task',
          status: 'working',
          failure: null,
          next: 'last line',
          updatedAt: new Date().toISOString(),
        },
      });
    }
    return send(res, 404, { error: 'not found' });
  });
  return {
    server,
    calls,
    timers,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---- Run ----
const startedAt = Date.now();
const workdir = await mkdtemp(join(tmpdir(), 'me-native-accept-'));
let home = null;
let fixture = null;
try {
  fixture = createNativeFixture();
  const fixtureBase = await fixture.start();

  const FULL_ENV = {
    ME_UPSTREAM_MODE: 'full',
    UPSTREAM_SERVER_URL: fixtureBase,
    DATABASE_URL: 'postgres://openbot:x@postgres:5432/openbot',
    KEY_ENCRYPTION_KEY: 'k'.repeat(44),
    ME_HOME_BRIDGE_SECRET: BRIDGE_SECRET,
    INTELLIGENCE_API_URL: 'https://intel.home.example',
    INTELLIGENCE_GATEWAY_WS_URL: 'wss://intel.home.example',
    CPK_INTELLIGENCE_API_KEY: 'k',
    BETTER_AUTH_URL: fixtureBase,
    BETTER_AUTH_SECRET: 's'.repeat(32),
    INITIAL_ADMIN_EMAILS: 'alice@example.com',
    ME_UPSTREAM_ADMIN_USERS: 'alice',
    COMPUTER_SUPERVISOR_URL: 'http://127.0.0.1:4500',
    SUPERVISOR_TOKEN: 's',
    COMPUTER_TOKEN: 'c',
  };
  home = createHomeServer({
    dbPath: join(workdir, 'home.sqlite'),
    env: { ...process.env, ...FULL_ENV },
  });
  const info = await home.start({ host: '127.0.0.1', port: 0 });
  const homeBase = `http://${info.host}:${info.port}`;
  for (const u of ['alice', 'bob']) ensureUser(home.db, u, u);

  async function enroll(user, label) {
    const { phone, secure } = makePhone(homeBase);
    const inv = createInvitation(home.db, user, 60_000);
    const summary = await phone.enrollOneTime(
      { homeBaseUrl: homeBase, invitationId: inv.invitation_id, pairingSecret: inv.invitation_secret },
      { label },
    );
    return { phone, secure, summary };
  }

  // T1: two paired families, owner-validated auth + roster.
  const alice = await enroll('alice', "Alice phone");
  const bob = await enroll('bob', "Bob phone");
  check('enroll.alice', alice.summary.userId === 'alice', `user=${alice.summary.userId}`);
  check('enroll.bob', bob.summary.userId === 'bob', `user=${bob.summary.userId}`);
  const aliceNative = new UpstreamNativeClient(nativeTransportFor(alice.phone));
  const bobNative = new UpstreamNativeClient(nativeTransportFor(bob.phone));
  const roster = await aliceNative.listAgents();
  check('roster.strict-parse', roster.length === 1 && roster[0].id === 'bot_main', JSON.stringify(roster[0] ?? null));

  // Readiness bypass is explicit: no doctor cache -> fullConfigured false, transport still works.
  const hz = await (await fetch(`${homeBase}/healthz`)).json();
  check('readiness.bypassed-not-claimed', hz.fullConfigured === false && hz.agentMode === 'full-upstream', `fullConfigured=${hz.fullConfigured}`);

  // T2/T3/T4 per family: two channels each (array + envelope history shapes).
  const aliceChannels = [];
  for (let i = 0; i < 2; i++) {
    const ch = await aliceNative.createChannel(['bot_main']);
    aliceChannels.push(ch);
  }
  const bobChannels = [];
  for (let i = 0; i < 2; i++) {
    const ch = await bobNative.createChannel(['bot_main']);
    bobChannels.push(ch);
  }
  check('channels.two-each', aliceChannels.length === 2 && bobChannels.length === 2);
  check('channels.isolated', new Set([...aliceChannels, ...bobChannels].map((c) => c.id)).size === 4);

  const shapes = [];
  for (const ch of aliceChannels) {
    const h = await aliceNative.getHistory(ch.id, 'bot_main');
    shapes.push(Array.isArray(h) ? h.length : -1);
  }
  for (const ch of bobChannels) {
    const h = await bobNative.getHistory(ch.id, 'bot_main');
    shapes.push(Array.isArray(h) ? h.length : -1);
  }
  check('history.empty-both-shapes', shapes.every((s) => s === 0), `lengths=${shapes.join(',')}`);

  // T4: 202 submit + same-UUID retry idempotency + eventual hydration.
  const controller = new NativeConversationController(aliceNative, () => randomUUID());
  const fence = { capture: () => ({ generation: 0, scopeKey: 'alice' }), isCurrent: () => true };
  const target = aliceChannels[0];
  const key = randomUUID();
  const first = await aliceNative.sendNativeMessage(target.id, { agentId: 'bot_main', text: 'hello upstream', externalId: key });
  check('send.202', first.accepted === true && first.externalId === key);
  const retry = await aliceNative.sendNativeMessage(target.id, { agentId: 'bot_main', text: 'hello upstream', externalId: key });
  check('send.same-uuid-retry-202', retry.accepted === true);
  const afterRetry = await aliceNative.getHistory(target.id, 'bot_main');
  const userMsgs = afterRetry.filter((m) => m.role === 'user');
  check('send.no-duplicate-on-retry', userMsgs.length === 1, `userMsgs=${userMsgs.length}`);
  const synced = await controller.sendAndSync({
    channelId: target.id,
    agentId: 'bot_main',
    text: 'second turn',
    fence,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollAttempts: 10,
    pollIntervalMs: 150,
  });
  check('send.hydrated', synced.accepted && synced.answered, `attempts=${synced.attempts} answered=${synced.answered}`);

  // Second channel exercises the ENVELOPE history shape with real parser.
  const env = await aliceNative.getHistory(aliceChannels[1].id, 'bot_main');
  check('history.envelope-shape-parsed', Array.isArray(env), `len=${env.length}`);
  await aliceNative.sendNativeMessage(aliceChannels[1].id, { agentId: 'bot_main', text: 'envelope turn', externalId: randomUUID() });
  await new Promise((r) => setTimeout(r, 600));
  const envAfter = await aliceNative.getHistory(aliceChannels[1].id, 'bot_main');
  check('history.envelope-hydrated', envAfter.some((m) => m.role === 'assistant'), `len=${envAfter.length}`);

  // T5: cross-owner denied.
  let bobHistCode = '';
  try {
    await bobNative.getHistory(target.id, 'bot_main');
  } catch (e) {
    bobHistCode = e?.code ?? String(e);
  }
  check('isolation.cross-history-denied', ['INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN'].includes(bobHistCode), bobHistCode);
  let bobSendCode = '';
  try {
    await bobNative.sendNativeMessage(target.id, { agentId: 'bot_main', text: 'intrude', externalId: randomUUID() });
  } catch (e) {
    bobSendCode = e?.code ?? String(e);
  }
  check('isolation.cross-send-denied', ['INVALID_INPUT', 'NOT_FOUND', 'FORBIDDEN'].includes(bobSendCode), bobSendCode);
  const bobSawAlice = fixture.calls.some((c) => c.owner === 'u_bob' && c.path.includes(target.id));
  check('isolation.owner-scoped-assertion', bobSawAlice, 'bob upstream id asserted on his refused call');

  // T2 detail: headers/body discipline across all fixture calls.
  // Port note (single documented divergence from the E original): the home
  // live-evidence tracker probes the ANONYMOUS upstream surface (/health,
  // /api/capabilities — anonymous per pinned server/src/app.ts) with no
  // credentials at all. Those calls carry no assertion by design; every
  // other call must.
  const ANON = new Set(['/health', '/api/health', '/api/capabilities']);
  const leaked = fixture.calls.filter((c) => c.hadPhoneCreds);
  const noAssertion = fixture.calls.filter((c) => !c.owner && !ANON.has(c.path));
  const anonCredless = fixture.calls.filter((c) => ANON.has(c.path) && (c.hadPhoneCreds || c.owner));
  check('auth.no-phone-creds-upstream', leaked.length === 0, `calls=${fixture.calls.length} leaked=${leaked.length}`);
  check('auth.assertion-every-call', noAssertion.length === 0 && anonCredless.length === 0, `calls=${fixture.calls.length} missing=${noAssertion.length} anonCreds=${anonCredless.length}`);
  const roles = new Set(fixture.calls.map((c) => `${c.owner}:${c.role}`));
  check('auth.per-owner-roles', roles.has('u_alice:admin') && roles.has('u_bob:user'), [...roles].join(','));

  // T9: forged phone assertion overwritten server-side (real session token
  // read back from this test's own in-memory store; never logged).
  const aliceEnrollment = JSON.parse(await alice.secure.getItem('me.home.enrollment.v1'));
  const forgedCallsBefore = fixture.calls.length;
  const forged = await fetch(`${homeBase}/api/agents`, {
    headers: {
      authorization: `Bearer ${aliceEnrollment.sessionToken}`,
      'x-me-home-assertion': 'v2.forged.9999999999999.user.deadbeefdeadbeefdeadbeefdeadbeef',
    },
  });
  const forgedSawValid = fixture.calls.slice(forgedCallsBefore).every((c) => c.owner === 'u_alice' && !c.forgedSeen);
  check('auth.forged-header-overwritten', forged.status === 200 && forgedSawValid, `status=${forged.status}`);

  // T7: approvals inbox + decision + question respond (real DTO shapes).
  const inbox = await aliceNative.getNativeApprovals();
  check('approvals.inbox-parsed', inbox.requests.length === 1 && inbox.questions?.length === 1, `req=${inbox.requests.length} q=${inbox.questions?.length}`);
  await aliceNative.decideNativeApproval('apr_1', 'allow_once');
  await aliceNative.respondNativeQuestion('q_1', 'Tuesday');
  const decSeen = fixture.calls.filter((c) => c.path.includes('/decision') || c.path.includes('/respond'));
  check('approvals.decision-respond-proxied', decSeen.length === 2, `proxied=${decSeen.length}`);

  // T8: tasks list/get parse real BotTask shapes.
  const tasks = await aliceNative.listNativeTasks();
  const one = await aliceNative.getNativeTask(tasks[0].id);
  check('tasks.parsed', tasks.length >= 1 && one.channelId === aliceChannels[0].id, `tasks=${tasks.length} ch=${one.channelId}`);

  // T6: revoked phone makes no upstream calls.
  const callsBefore = fixture.calls.length;
  await bob.phone.revokeOwnDevice();
  let revokedCode = '';
  try {
    await bobNative.listAgents();
  } catch (e) {
    revokedCode = e?.code ?? String(e);
  }
  check('revoked.local-refusal', revokedCode === 'DEVICE_REVOKED', revokedCode);
  check('revoked.no-upstream-calls', fixture.calls.length === callsBefore, `before=${callsBefore} after=${fixture.calls.length}`);

  const ms = Date.now() - startedAt;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const summary = {
    tool: 'audit-native/run-native-acceptance.mjs',
    finishedAt: new Date().toISOString(),
    durationMs: ms,
    passed,
    failed: failed.length,
    cases: results,
    fixture: {
      label: FIXTURE_LABEL,
      transport: 'loopback HTTP 127.0.0.1 (real TCP, ephemeral port)',
      limits: 'assistant replies are canned hydration strings on a 250ms timer, NOT model output; same-externalId+different-body 409 is fixture-only policy, not claimed upstream behavior; approvals/tasks canned per pinned DTOs; devices/routines/memory/proactive not exercised by phone client methods',
      upstreamCalls: fixture.calls.length,
    },
    readinessNote: 'TEST harness wrote no doctor cache; /healthz fullConfigured=false. Transport acceptance explicitly bypasses product READY gating and claims no production readiness.',
    realModules: [
      `${ME}/phone-app/src/paired-home-client.ts`,
      `${ME}/phone-app/src/upstream-native.ts`,
      `${ME}/phone-app/src/upstream-conversation.ts`,
      `${ME}/infra-server/src/server.mjs`,
      `${ME}/infra-server/src/upstream-proxy.mjs`,
      `${ME}/infra-server/src/upstream-identity.mjs`,
    ],
  };
  await writeFile(join(OUT_DIR, 'result.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2));
  if (failed.length > 0) process.exitCode = 1;
} finally {
  try {
    await home?.stop();
  } catch { /* best effort */ }
  try {
    await fixture?.stop();
  } catch { /* best effort */ }
  await rm(workdir, { recursive: true, force: true });
}
