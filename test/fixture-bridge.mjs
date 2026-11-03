#!/usr/bin/env node
// TEST FIXTURE ONLY — mirrors runtime-bridge-v1 over stdio so home-service
// integration tests exercise the real subprocess/JSONL path. Not a production
// runtime: deterministic, offline, fixture-model only.
//
// Directives in `request` text (fixture model only):
//   ASK:<prompt>            -> waiting_input with questions [{id:'q1', prompt}]
//   ASKAFTER:<n>:<prompt>   -> n progress events, then waiting_input (liveness)
//   APPROVE:<action>        -> awaiting_approval with approvals [{id:'a1', ...}]
//   FAIL:<message>          -> failed
//   ARTIFACT:<name>:<body>  -> write output/<name>, declare it on completion
//   SLEEP:<seconds>         -> progress ticks, then completed (cancellable)
//   STALL:                  -> sleep forever (tests bounded shutdown; SIGKILL ends it)
//   IGNORETERM:             -> ignore SIGTERM (tests TERM->KILL escalation; combine with STALL)
//   STREAM:<n>              -> n progress events with delays, then completed
//   GARBAGE:                -> emit a non-JSON stdout line (protocol violation)
//   BIGLINE:                -> emit a 300 KiB stdout line (oversize output)
//   BIGARTIFACT:<name>:<n>  -> write/declare an n-byte artifact (size cap)
//   MULTIARTIFACT:<n>:<pfx> -> declare n tiny artifacts (count cap)
//   SYMLINKARTIFACT:<name>:<target> -> link output/<name> at target (escape test)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, posix, isAbsolute } from 'node:path';

let seq = 0;
const startedAt = Date.now();
let terminated = false;
let finalEmitted = false;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function event(base, extra) {
  seq += 1;
  send({ bridge: 'runtime-bridge-v1', run_id: base.run_id, seq, ...extra });
}

function result(base, status, extra = {}) {
  finalEmitted = true;
  event(base, { event: 'result', status, ...extra });
}

function fail(base, code, message) {
  result(base, 'failed', { error: { code, message } });
}

function installCancel(base) {
  const onSignal = () => {
    if (terminated) return;
    terminated = true;
    try {
      result(base, 'cancelled', { error: { code: 'cancelled', message: 'Interrupted by signal' } });
    } finally {
      process.exit(130);
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  // A single JSON object; trailing bytes/objects fail the parse below.
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    process.stderr.write('fixture-bridge: invalid request JSON\n');
    process.exit(2);
  }
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    process.stderr.write('fixture-bridge: request must be an object\n');
    process.exit(2);
  }
  const base = { run_id: req.run_id ?? 'run_unknown' };
  const ignoreTerm = /^IGNORETERM:/m.test(req.request ?? '');
  if (!ignoreTerm) {
    installCancel(base);
  } else {
    // Deliberately deaf to SIGTERM: the home must escalate to SIGKILL and
    // still shut down bounded. SIGKILL cannot be ignored.
    process.on('SIGTERM', () => {
      process.stderr.write('fixture-bridge: SIGTERM ignored (shutdown test)\n');
    });
  }

  const invalid = (message) => {
    fail(base, 'invalid_request', message);
    process.exit(2);
  };
  if (req.bridge !== 'runtime-bridge-v1') return invalid('bridge must be runtime-bridge-v1');
  if (req.op !== 'run' && req.op !== 'resume') return invalid('op must be run or resume');
  for (const f of ['run_id', 'user_id', 'conversation_id', 'workspace']) {
    if (typeof req[f] !== 'string' || !req[f]) return invalid(`${f} is required`);
  }
  if (!isAbsolute(req.workspace) || !existsSync(req.workspace)) {
    fail(base, 'workspace_denied', 'workspace must exist');
    process.exit(2);
  }
  if (req.op === 'run' && (typeof req.request !== 'string' || !req.request.trim() || req.request.length > 8000)) {
    return invalid('request text 1..8000 chars is required for op run');
  }
  if (req.model?.provider !== 'fixture') {
    fail(base, 'model_not_configured', `fixture bridge cannot serve provider ${req.model?.provider}`);
    process.exit(0);
  }

  mkdirSync(join(req.workspace, 'output'), { recursive: true });
  mkdirSync(join(req.workspace, '.me_runtime'), { recursive: true });
  const checkpointPath = join(req.workspace, '.me_runtime', 'checkpoint.json');
  const checkpoint = existsSync(checkpointPath)
    ? JSON.parse(readFileSync(checkpointPath, 'utf8'))
    : null;

  event(base, { event: 'started', user_id: req.user_id, conversation_id: req.conversation_id });
  event(base, { event: 'progress', message: 'fixture plan step 1/1' });

  const text = req.request ?? '';
  const match = (name) => {
    const m = text.match(new RegExp(`^${name}:(.*)$`, 'ms'));
    return m ? m[1].trim() : null;
  };

  if (req.op === 'resume') {
    if (!checkpoint || checkpoint.run_id !== req.run_id) {
      return invalid('resume requires a matching checkpoint');
    }
    if (checkpoint.waiting === 'input') {
      const inputs = req.inputs ?? [];
      const answer = inputs.find((i) => i.id === 'q1')?.answer;
      if (typeof answer !== 'string' || !answer.trim()) {
        return invalid('resume input q1 answer is required');
      }
      result(base, 'completed', { output: `fixture-echo: answered q1 with ${answer.slice(0, 200)}`, artifacts: [] });
      process.exit(0);
    }
    if (checkpoint.waiting === 'approval') {
      const decision = (req.approvals ?? []).find((a) => a.id === 'a1');
      if (!decision) return invalid('resume approval a1 decision is required');
      if (decision.decision === 'approve') {
        result(base, 'completed', { output: 'fixture-echo: approved action a1 executed', artifacts: [] });
      } else {
        result(base, 'failed', { error: { code: 'approval_rejected', message: 'approval a1 rejected' } });
      }
      process.exit(0);
    }
    return invalid('unknown checkpoint state');
  }

  const failMsg = match('FAIL');
  if (failMsg !== null) {
    result(base, 'failed', { error: { code: 'tool_error', message: failMsg.slice(0, 500) || 'fixture failure' } });
    process.exit(0);
  }
  const ask = match('ASK');
  if (ask !== null) {
    writeFileSync(checkpointPath, JSON.stringify({ run_id: req.run_id, waiting: 'input' }));
    result(base, 'waiting_input', { questions: [{ id: 'q1', prompt: ask.slice(0, 500) || 'Fixture question?' }] });
    process.exit(0);
  }
  const approve = match('APPROVE');
  if (approve !== null) {
    writeFileSync(checkpointPath, JSON.stringify({ run_id: req.run_id, waiting: 'approval' }));
    result(base, 'awaiting_approval', {
      approvals: [{ id: 'a1', action: approve.slice(0, 200) || 'fixture gated action', args: {}, reason: 'fixture approval gate' }],
    });
    process.exit(0);
  }
  const sleepSecs = Number(match('SLEEP') ?? 'NaN');
  if (Number.isFinite(sleepSecs) && sleepSecs > 0) {    const deadline = Date.now() + Math.min(sleepSecs, 120) * 1000;
    let tick = 0;
    while (Date.now() < deadline && !terminated) {
      await new Promise((r) => setTimeout(r, 100));
      tick += 1;
      if (tick % 10 === 0) event(base, { event: 'progress', message: `sleeping ${tick / 10}s` });
    }
    if (terminated) return; // signal handler already emitted + exited
    result(base, 'completed', { output: 'fixture-echo: slept', artifacts: [] });
    process.exit(0);
  }
  if (/^STALL:/m.test(text)) {
    // Sleep forever without progress. SIGTERM cancels (unless IGNORETERM is
    // also set); SIGKILL always ends it. Exercises home shutdown bounds.
    event(base, { event: 'started', user_id: req.user_id, conversation_id: req.conversation_id });
    while (!terminated) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return; // signal handler already emitted + exited
  }
  const streamMatch = match('STREAM');
  if (streamMatch !== null) {
    const n = Math.max(1, Math.min(200, Number(streamMatch) || 10));
    for (let i = 1; i <= n && !terminated; i++) {
      event(base, { event: 'progress', message: `stream tick ${i}/${n}` });
      await new Promise((r) => setTimeout(r, 25));
    }
    if (terminated) return;
    result(base, 'completed', { output: 'fixture-echo: streamed', artifacts: [] });
    process.exit(0);
  }
  const askAfter = text.match(/^ASKAFTER:(\d+):([\s\S]*)$/m);
  if (askAfter) {
    const n = Math.max(1, Math.min(100, Number(askAfter[1])));
    for (let i = 1; i <= n && !terminated; i++) {
      event(base, { event: 'progress', message: `thinking ${i}/${n}` });
      await new Promise((r) => setTimeout(r, 25));
    }
    if (terminated) return;
    writeFileSync(checkpointPath, JSON.stringify({ run_id: req.run_id, waiting: 'input' }));
    result(base, 'waiting_input', { questions: [{ id: 'q1', prompt: askAfter[2].trim().slice(0, 500) || 'Fixture question?' }] });
    process.exit(0);
  }
  if (/^GARBAGE:/m.test(text)) {
    event(base, { event: 'progress', message: 'about to emit garbage' });
    process.stdout.write('{"broken": tru\n');
    await new Promise((r) => setTimeout(r, 500));
    result(base, 'completed', { output: 'unreachable', artifacts: [] });
    process.exit(0);
  }
  if (/^BIGLINE:/m.test(text)) {
    process.stdout.write(`${'x'.repeat(300 * 1024)}\n`);
    await new Promise((r) => setTimeout(r, 500));
    result(base, 'completed', { output: 'unreachable', artifacts: [] });
    process.exit(0);
  }
  const bigArtifact = text.match(/^BIGARTIFACT:([^:\n]+):(\d+)$/m);
  if (bigArtifact) {
    // Declare (and write) an oversized artifact to test the home size cap.
    const body = 'x'.repeat(Math.min(Number(bigArtifact[2]), 12 * 1024 * 1024));
    writeFileSync(join(req.workspace, 'output', bigArtifact[1].trim()), body);
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    result(base, 'completed', {
      output: 'fixture-echo: big artifact',
      artifacts: [{ path: `output/${bigArtifact[1].trim()}`, bytes: body.length, sha256 }],
    });
    process.exit(0);
  }
  const multiArtifact = text.match(/^MULTIARTIFACT:(\d+):([A-Za-z0-9_-]+)$/m);
  if (multiArtifact) {
    // Declare many tiny artifacts to test the per-task count cap.
    const n = Math.max(1, Math.min(200, Number(multiArtifact[1])));
    const declared = [];
    for (let i = 0; i < n; i++) {
      const name = `${multiArtifact[2]}-${i}.txt`;
      writeFileSync(join(req.workspace, 'output', name), 'x');
      declared.push({ path: `output/${name}`, bytes: 1, sha256: createHash('sha256').update('x').digest('hex') });
    }
    result(base, 'completed', { output: 'fixture-echo: many artifacts', artifacts: declared });
    process.exit(0);
  }
  const symlinkArtifact = text.match(/^SYMLINKARTIFACT:([^:\n]+):([^\n]+)$/m);
  if (symlinkArtifact) {
    // Link output/<name> at an outside target to test home symlink rejection.
    const { symlinkSync, readFileSync: readTarget } = await import('node:fs');
    const target = symlinkArtifact[2].trim();
    const linkPath = join(req.workspace, 'output', symlinkArtifact[1].trim());
    symlinkSync(target, linkPath);
    const content = readTarget(target);
    result(base, 'completed', {
      output: 'fixture-echo: symlink artifact',
      artifacts: [{
        path: `output/${symlinkArtifact[1].trim()}`,
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      }],
    });
    process.exit(0);
  }
  const artifacts = [];
  const artMatch = text.match(/^ARTIFACT:([^:\n]+):([\s\S]*)$/m);
  if (artMatch) {
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
    artifacts.push({ path: `output/${posixName}`, bytes, sha256 });
    event(base, { event: 'artifact', path: `output/${posixName}`, bytes, sha256 });
  }
  result(base, 'completed', {
    output: `fixture-echo: ${text.slice(0, 200)}`,
    artifacts,
    model: { provider: 'fixture', model: req.model?.model ?? 'fixture-echo' },
  });
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`fixture-bridge: internal error ${error?.message ?? error}\n`);
  if (!finalEmitted) {
    try {
      send({ bridge: 'runtime-bridge-v1', event: 'result', status: 'failed', seq: seq + 1, error: { code: 'internal', message: 'fixture crashed' } });
    } catch { /* stdout gone */ }
  }
  process.exit(2);
});
