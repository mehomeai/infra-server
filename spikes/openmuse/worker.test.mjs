import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HomeStore } from './home-store.mjs';
import { submit, answer, fixtureWorker, TaskWorker } from './home-tasks.mjs';

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'me-home-test-'));
  const path = join(dir, 'home.sqlite');
  const stores = [];
  const open = () => {
    const store = new HomeStore(path);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) {
      try { await store.close(); } catch { /* An explicit restart already closed it. */ }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { path, open, store: open() };
}

test('one input wait allows other users/conversations to finish with scoped records', async t => {
  const { store } = await home(t);
  const waiting = await submit(store, 'alice', 'a-1', 'private draft', { needsAnswer: true });
  const a2 = await submit(store, 'alice', 'a-2', 'private report');
  const b1 = await submit(store, 'bob', 'b-1', 'private notes');
  const b2 = await submit(store, 'bob', 'b-2', 'private list');
  const worker = fixtureWorker(store);
  await worker.tick();
  await worker.tick();
  assert.equal((await store.get('alice', 'tasks', waiting.id)).status, 'waiting_input');
  for (const [owner, task] of [['alice', a2], ['bob', b1], ['bob', b2]]) {
    const saved = await store.get(owner, 'tasks', task.id);
    assert.equal(saved.status, 'succeeded');
    const artifact = await store.get(owner, 'artifacts', saved.artifactIds[0]);
    assert.equal(artifact.conversationId, task.input.conversationId);
    assert.equal(await store.get(owner === 'alice' ? 'bob' : 'alice', 'artifacts', artifact.id), null);
  }
  await assert.rejects(answer(store, 'bob', waiting.id, 'stolen answer'), /Task not found/);
  assert.equal((await store.list('alice', 'tasks')).length, 2);
  assert.equal((await store.list('bob', 'tasks')).length, 2);
});

test('waiting input and artifacts persist across closing/reopening the home database', async t => {
  const { store, open } = await home(t);
  const task = await submit(store, 'alice', 'chat-1', 'make a draft', { needsAnswer: true });
  await fixtureWorker(store).tick();
  await store.close();
  const restarted = open();
  assert.equal((await restarted.get('alice', 'tasks', task.id)).status, 'waiting_input');
  assert.ok(await answer(restarted, 'alice', task.id, 'MP4'));
  assert.equal(await answer(restarted, 'alice', task.id, 'duplicate answer'), null);
  await fixtureWorker(restarted).tick();
  const saved = await restarted.get('alice', 'tasks', task.id);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.attempts, 2);
  assert.equal((await restarted.get('alice', 'artifacts', saved.artifactIds[0])).text,
    'make a draft (MP4)');
});

test('separate worker/store instances race for a single claim without duplicate execution', async t => {
  const { store, open } = await home(t);
  const task = await submit(store, 'alice', 'chat-1', 'run once');
  let executions = 0;
  const handler = async () => {
    executions++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { status: 'succeeded' };
  };
  await Promise.all([
    new TaskWorker(store, handler).tick(),
    new TaskWorker(open(), handler).tick(),
  ]);
  assert.equal(executions, 1);
  assert.equal((await store.get('alice', 'tasks', task.id)).attempts, 1);
});

test('an actual child-process crash leaves a checkpoint recoverable after lease expiry', async t => {
  const { store, path } = await home(t);
  const child = spawnSync(process.execPath, [
    '--experimental-transform-types', '--disable-warning=ExperimentalWarning',
    new URL('./crash-fixture.mjs', import.meta.url).pathname, path,
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 77, child.stderr);
  const id = child.stdout.trim();
  const interrupted = await store.get('alice', 'tasks', id);
  assert.equal(interrupted.status, 'running');
  assert.equal(interrupted.state.stage, 'checkpoint-before-crash');
  const worker = new TaskWorker(store, async (_owner, task) => {
    assert.equal(task.state.stage, 'checkpoint-before-crash');
    return { status: 'succeeded', result: 'recovered' };
  }, { now: () => Date.parse(interrupted.leaseUntil) + 1 });
  await worker.tick();
  const recovered = await store.get('alice', 'tasks', id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.attempts, 2);
});

test('pending review does not occupy a worker slot and resolved review becomes eligible', async t => {
  const { store } = await home(t);
  const waiting = await submit(store, 'alice', 'chat-1', 'reviewed action');
  await store.put('alice', 'actions', {
    id: 'action-1', status: 'awaiting_review', expiresAt: '2100-01-01T00:00:00Z',
  });
  await store.compareAndSwap('alice', 'tasks', waiting.id, { status: 'queued' }, {
    status: 'waiting_approval', actionId: 'action-1',
  });
  const other = await submit(store, 'bob', 'chat-2', 'independent');
  const executed = [];
  const worker = new TaskWorker(store, async (owner, task) => {
    executed.push([owner, task.id]);
    return { status: 'succeeded' };
  });
  await worker.tick();
  assert.deepEqual(executed, [['bob', other.id]]);
  await store.compareAndSwap('alice', 'actions', 'action-1', { status: 'awaiting_review' },
    { status: 'approved' });
  await worker.tick();
  assert.deepEqual(executed[1], ['alice', waiting.id]);
  // This verifies worker eligibility, not a production approval broker or a real side effect.
});

test('cancellation aborts active work and rejects its late checkpoint/result', async t => {
  const { store } = await home(t);
  const task = await submit(store, 'alice', 'chat-1', 'cancel me');
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = new TaskWorker(store, async (_owner, _task, context) => {
    entered();
    await gate;
    await context.guard();
    return { status: 'succeeded' };
  });
  const running = worker.tick();
  await started;
  await store.compareAndSwap('alice', 'tasks', task.id, { status: 'running' },
    { status: 'cancelled', leaseId: null, leaseUntil: null });
  worker.abort(task.id);
  release();
  await running;
  assert.equal((await store.get('alice', 'tasks', task.id)).status, 'cancelled');
});

test('a stale worker cannot overwrite a paused task', async t => {
  const { store } = await home(t);
  const task = await submit(store, 'alice', 'chat-1', 'pause me');
  const worker = new TaskWorker(store, async (_owner, _task, context) => {
    await store.compareAndSwap('alice', 'tasks', task.id, { status: 'running' },
      { status: 'paused' });
    await context.checkpoint({ status: 'succeeded', result: 'must not persist' });
    return { status: 'succeeded' };
  });
  await worker.tick();
  const saved = await store.get('alice', 'tasks', task.id);
  assert.equal(saved.status, 'paused');
  assert.equal(saved.result, undefined);
});

test('handler failure is recorded and not automatically re-executed as queued work', async t => {
  const { store } = await home(t);
  const task = await submit(store, 'alice', 'chat-1', 'fail me');
  let attempts = 0;
  const worker = new TaskWorker(store, async () => {
    attempts++;
    throw new Error('synthetic failure');
  });
  await worker.tick();
  await worker.tick();
  const saved = await store.get('alice', 'tasks', task.id);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.error, 'synthetic failure');
  assert.equal(attempts, 1);
  assert.equal((await store.list('alice', 'run-events'))[0].kind, 'error');
});
