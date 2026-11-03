#!/usr/bin/env node
// TEST FIXTURE ONLY — delegation-aware runtime-bridge-v1 over stdio + fd-3
// task-rpc-v1. Proves the home fd-3 duplex path with a real subprocess.
// Not a production runtime: deterministic, offline, fixture-model only.
//
// Parent directives (in `request` text, op run):
//   SPAWN:<key>:<child request>   — submit one child via fd-3 RPC (repeatable)
//   ASK:<prompt>                  — after spawns, pause as waiting_input (q1)
//   COMPLETE_EARLY                — return completed even with active children
//                                 (home must hold as waiting_children)
//   DUPTEST:<key>:<child request> — duplicate same-key same/different payload
//                                 via RPC, then wait for children
//   WIDETEST:<key>:<child request>— attempt code_exec:true widening (must be
//                                 denied), then wait for no children -> fail
//                                 honestly if denial missing
// Child directives (child request text, no SPAWN):
//   FAIL:<msg>                    — failed
//   SLEEP:<secs>                  — sleep ticks then completed (cancellable)
//   ARTIFACT:<name>:<body>        — write output/<name>, declare it
//   ASK:<prompt>                  — waiting_input with questions [{id:'q1'}]
//   APPROVE:<action>              — awaiting_approval with approvals [{id:'a1'}]
// Otherwise completed with `fixture-delegation-echo: ...`.
//
// On op resume with `child_results`, returns completed aggregating them.
// On op resume with `inputs`, returns completed echoing the answer.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, posix, isAbsolute } from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';

let seq = 0;
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function event(base, extra) {
  seq += 1;
  send({ bridge: 'runtime-bridge-v1', run_id: base.run_id, seq, ...extra });
}
function result(base, status, extra = {}) {
  event(base, { event: 'result', status, ...extra });
}

function installCancel(base) {
  const onSignal = () => {
    try { result(base, 'cancelled', { error: { code: 'cancelled', message: 'Interrupted by signal' } }); }
    finally { process.exit(130); }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

function openRpc() {
  const fdVar = process.env.ME_HOME_TASK_RPC_FD ?? '3';
  const fd = Number(fdVar);
  if (!Number.isInteger(fd) || fd < 3) return null;
  try {
    const sock = new net.Socket({ fd, readable: true, writable: true });
    return sock;
  } catch {
    return null;
  }
}

function rpcCall(sock, id, method, params, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = JSON.stringify({ rpc: 'task-rpc-v1', id, method, params }) + '\n';
    let buf = '';
    const timer = setTimeout(() => {
      sock.removeListener('data', onData);
      reject(new Error(`rpc ${method} timed out`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.rpc !== 'task-rpc-v1' || msg?.id !== id) continue;
        clearTimeout(timer);
        sock.removeListener('data', onData);
        if (msg.ok) resolve(msg.result);
        else {
          const err = new Error(msg.error?.message ?? 'rpc failed');
          err.code = msg.error?.code ?? 'bad_request';
          reject(err);
        }
        return;
      }
    };
    sock.on('data', onData);
    sock.write(req, (err) => {
      if (err) {
        clearTimeout(timer);
        sock.removeListener('data', onData);
        reject(err);
      }
    });
  });
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let req;
  try {
    req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.stderr.write('fixture-delegation: invalid request JSON\n');
    process.exit(2);
  }
  const base = { run_id: req.run_id ?? 'run_unknown' };
  installCancel(base);
  if (req.bridge !== 'runtime-bridge-v1') {
    result(base, 'failed', { error: { code: 'invalid_request', message: 'bridge must be runtime-bridge-v1' } });
    process.exit(0);
  }
  if (!isAbsolute(req.workspace ?? '') || !existsSync(req.workspace ?? '')) {
    result(base, 'failed', { error: { code: 'workspace_denied', message: 'workspace must exist' } });
    process.exit(2);
  }
  mkdirSync(join(req.workspace, 'output'), { recursive: true });
  mkdirSync(join(req.workspace, '.me_runtime'), { recursive: true });
  event(base, { event: 'started', user_id: req.user_id, conversation_id: req.conversation_id });
  event(base, { event: 'progress', message: 'fixture-delegation plan step 1/1' });

  const text = req.op === 'run' ? (req.request ?? '') : '';

  // Resume path: aggregate trusted child results, never re-spawn.
  // Approval decisions (parent or child) resolve first; parents never carry
  // approvals in current tests, so existing child_results flows are unaffected.
  if (req.op === 'resume') {
    const childResults = req.child_results ?? [];
    const inputs = req.inputs ?? [];
    const decision = (req.approvals ?? []).find((a) => a.id === 'a1')?.decision;
    if (decision === 'approve') {
      result(base, 'completed', { output: 'fixture-delegation-echo: approved action a1 executed', artifacts: [] });
      process.exit(0);
    }
    if (decision === 'reject') {
      result(base, 'failed', { error: { code: 'approval_rejected', message: 'approval a1 rejected' } });
      process.exit(0);
    }
    const answer = inputs.find((i) => i.id === 'q1')?.answer;
    if (answer && childResults.length === 0) {
      result(base, 'completed', { output: `fixture-delegation-echo: answered q1 with ${String(answer).slice(0, 100)}`, artifacts: [] });
      process.exit(0);
    }
    if (answer && childResults.length > 0) {
      result(base, 'completed', { output: `fixture-delegation-echo: answered q1 with ${String(answer).slice(0, 100)} children=${childResults.length}`, artifacts: [] });
      process.exit(0);
    }
    if (Array.isArray(childResults) && childResults.length > 0) {
      const summary = childResults.map((c) => `${c.id.slice(0, 13)}:${c.status}`).join(',');
      const firstOut = childResults.find((c) => c.status === 'succeeded')?.output ?? '';
      result(base, 'completed', { output: `fixture-delegation-echo: parent done children=${childResults.length} [${summary}] first=${String(firstOut).slice(0, 200)}`, artifacts: [] });
      process.exit(0);
    }
    result(base, 'failed', { error: { code: 'invalid_request', message: 'resume needs child_results or q1 answer' } });
    process.exit(0);
  }

  // Run path: child-only requests (no SPAWN) behave like the simple fixture.
  // Line-based directives (single-line child requests keep parsing robust).
  const lines = String(text).split('\n');
  const spawns = [];
  for (const line of lines) {
    if (line.startsWith('SPAWN:')) {
      const rest = line.slice('SPAWN:'.length);
      const sepIdx = rest.indexOf(':');
      if (sepIdx > 0) {
        const key = rest.slice(0, sepIdx).trim();
        const creq = rest.slice(sepIdx + 1).trim();
        if (key && creq) spawns.push({ key, request: creq });
      }
    }
  }
  const askLine = lines.find((l) => l.startsWith('ASK:'));
  const askMatch = askLine ? [askLine, askLine.slice('ASK:'.length).trim()] : null;
  const dupLine = lines.find((l) => l.startsWith('DUPTEST:'));
  let dupMatch = null;
  if (dupLine) {
    const rest = dupLine.slice('DUPTEST:'.length);
    const sepIdx = rest.indexOf(':');
    if (sepIdx > 0) dupMatch = [dupLine, rest.slice(0, sepIdx).trim(), rest.slice(sepIdx + 1).trim()];
  }
  const wideLine = lines.find((l) => l.startsWith('WIDETEST:'));
  let wideMatch = null;
  if (wideLine) {
    const rest = wideLine.slice('WIDETEST:'.length);
    const sepIdx = rest.indexOf(':');
    if (sepIdx > 0) wideMatch = [wideLine, rest.slice(0, sepIdx).trim(), rest.slice(sepIdx + 1).trim() || 'wide child'];
    else wideMatch = [wideLine, rest.trim() || 'widekey', 'wide child'];
  }
  const completeEarly = lines.some((l) => l.trim() === 'COMPLETE_EARLY');
  const garbageAfter = lines.some((l) => l.trim() === 'GARBAGE_AFTER_SPAWN');
  const failLine = lines.find((l) => l.startsWith('FAIL:'));
  const failMsg = failLine ? failLine.slice('FAIL:'.length).trim() : null;
  const sleepLine = lines.find((l) => l.startsWith('SLEEP:'));
  const sleepSecs = sleepLine ? Number(sleepLine.slice('SLEEP:'.length).trim()) : NaN;
  const artLine = lines.find((l) => l.startsWith('ARTIFACT:'));
  let artMatch = null;
  if (artLine) {
    const rest = artLine.slice('ARTIFACT:'.length);
    const sepIdx = rest.indexOf(':');
    if (sepIdx > 0) artMatch = [artLine, rest.slice(0, sepIdx).trim(), rest.slice(sepIdx + 1)];
  }

  if (failMsg !== null && spawns.length === 0 && !dupMatch && !wideMatch) {
    result(base, 'failed', { error: { code: 'tool_error', message: failMsg.slice(0, 500) || 'fixture failure' } });
    process.exit(0);
  }
  if (Number.isFinite(sleepSecs) && sleepSecs > 0 && spawns.length === 0) {
    const deadline = Date.now() + Math.min(sleepSecs, 60) * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      tick += 1;
      if (tick % 10 === 0) event(base, { event: 'progress', message: `sleeping ${tick / 10}s` });
    }
    result(base, 'completed', { output: 'fixture-delegation-echo: slept', artifacts: [] });
    process.exit(0);
  }
  if (artMatch && spawns.length === 0 && !dupMatch && !wideMatch) {
    const name = artMatch[1].trim().replace(/\\/g, '/');
    const posixName = posix.normalize(name);
    if (!name || posixName.startsWith('..') || isAbsolute(posixName) || posixName.startsWith('.me_runtime')) {
      result(base, 'failed', { error: { code: 'invalid_request', message: 'artifact path escapes workspace' } });
      process.exit(0);
    }
    const body = artMatch[2];
    writeFileSync(join(req.workspace, 'output', posixName), body);
    const bytes = Buffer.byteLength(body);
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    event(base, { event: 'artifact', path: `output/${posixName}`, bytes, sha256 });
    result(base, 'completed', { output: `fixture-delegation-echo: ${text.slice(0, 200)}`, artifacts: [{ path: `output/${posixName}`, bytes, sha256 }] });
    process.exit(0);
  }

  // Child human-wait directives (H7.1): a delegated child asking while the
  // phone is closed must still alert. Mirrors the simple fixture's inbox
  // gates; resume with inputs/approvals completes via the resume path above.
  const approveLine = lines.find((l) => l.startsWith('APPROVE:'));
  if (approveLine && spawns.length === 0 && !dupMatch && !wideMatch) {
    const action = approveLine.slice('APPROVE:'.length).trim().slice(0, 200) || 'fixture gated action';
    result(base, 'awaiting_approval', {
      approvals: [{ id: 'a1', action, args: {}, reason: 'fixture approval gate' }],
    });
    process.exit(0);
  }
  if (askMatch && spawns.length === 0 && !dupMatch && !wideMatch) {
    result(base, 'waiting_input', { questions: [{ id: 'q1', prompt: askMatch[1].trim().slice(0, 500) || 'Fixture question?' }] });
    process.exit(0);
  }

  // Parent path: needs fd-3 RPC.
  if (spawns.length === 0 && !dupMatch && !wideMatch) {
    result(base, 'completed', { output: `fixture-delegation-echo: ${text.slice(0, 200)}`, artifacts: [] });
    process.exit(0);
  }
  const sock = openRpc();
  if (!sock) {
    result(base, 'failed', { error: { code: 'internal', message: 'fd-3 RPC unavailable for SPAWN' } });
    process.exit(0);
  }

  try {
    const childIds = [];
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[i];
      const res = await rpcCall(sock, i + 1, 'submit_child', { key: s.key, request: s.request, title: `child ${s.key}` });
      childIds.push(res.child.id);
    }
    if (dupMatch) {
      const key = dupMatch[1].trim();
      const childReq = dupMatch[2].trim();
      const first = await rpcCall(sock, 100, 'submit_child', { key, request: childReq });
      const retry = await rpcCall(sock, 101, 'submit_child', { key, request: childReq });
      if (retry.child.id !== first.child.id) {
        result(base, 'failed', { error: { code: 'internal', message: 'idempotent retry returned different child' } });
        process.exit(0);
      }
      let conflictSeen = false;
      try {
        await rpcCall(sock, 102, 'submit_child', { key, request: `${childReq} different-payload` });
      } catch (e) {
        if (e.code === 'delegation_conflict') conflictSeen = true;
      }
      if (!conflictSeen) {
        result(base, 'failed', { error: { code: 'internal', message: 'different payload did not conflict' } });
        process.exit(0);
      }
      childIds.push(first.child.id);
      event(base, { event: 'progress', message: `dup ok ${first.child.id.slice(0, 13)}` });
    }
    if (wideMatch) {
      const key = wideMatch[1].trim();
      const childReq = wideMatch[2].trim() || 'wide child';
      let denied = false;
      try {
        await rpcCall(sock, 200, 'submit_child', { key, request: childReq, capabilities: { files: true, code_exec: true } });
      } catch (e) {
        if (e.code === 'capability_denied') denied = true;
      }
      if (!denied) {
        result(base, 'failed', { error: { code: 'internal', message: 'widening was not denied' } });
        process.exit(0);
      }
      event(base, { event: 'progress', message: 'wide denied ok' });
    }
    try { sock.destroy(); } catch { /* ignore */ }
    if (garbageAfter) {
      process.stdout.write('{"broken": tru\n');
      await new Promise((r) => setTimeout(r, 500));
      process.exit(0);
    }
    if (askMatch) {
      result(base, 'waiting_input', { questions: [{ id: 'q1', prompt: askMatch[1].trim().slice(0, 500) || 'Fixture question?' }] });
      process.exit(0);
    }
    if (completeEarly) {
      result(base, 'completed', { output: 'fixture-delegation-echo: early completed with active children', artifacts: [] });
      process.exit(0);
    }
    result(base, 'waiting_children', { children: childIds });
    process.exit(0);
  } catch (e) {
    try { sock.destroy(); } catch { /* ignore */ }
    result(base, 'failed', { error: { code: e.code ?? 'tool_error', message: String(e.message ?? e).slice(0, 500) } });
    process.exit(0);
  }
}

main().catch((error) => {
  process.stderr.write(`fixture-delegation: internal error ${error?.message ?? error}\n`);
  process.exit(2);
});
