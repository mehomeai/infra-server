import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeStore } from './home-store.mjs';
import { submit, answer, fixtureWorker } from './home-tasks.mjs';

const dir = await mkdtemp(join(tmpdir(), 'me-home-spike-'));
let store;
try {
  store = new HomeStore(join(dir, 'home.sqlite'));
  const waiting = await submit(store, 'alice', 'alice-chat-1', 'Draft animation', { needsAnswer: true });
  const independent = await submit(store, 'alice', 'alice-chat-2', 'Write report');
  const otherUser = await submit(store, 'bob', 'bob-chat-1', 'Summarize notes');
  await fixtureWorker(store).tick();
  assert.equal((await store.get('alice', 'tasks', waiting.id)).status, 'waiting_input');
  assert.equal((await store.get('alice', 'tasks', independent.id)).status, 'succeeded');
  assert.equal((await store.get('bob', 'tasks', otherUser.id)).status, 'succeeded');
  assert.equal(await store.get('bob', 'tasks', waiting.id), null);
  console.log('Real upstream worker: Alice waits for input; independent Alice/Bob tasks finish.');
  await store.close();
  store = new HomeStore(join(dir, 'home.sqlite'));
  await answer(store, 'alice', waiting.id, 'MP4');
  await fixtureWorker(store).tick();
  assert.equal((await store.get('alice', 'tasks', waiting.id)).status, 'succeeded');
  console.log('After reopening the home database: Alice answers and her waiting task finishes.');
  console.log('Model-free home-service spike only; no phone/backend authentication or live model tested.');
} finally {
  if (store) await store.close();
  await rm(dir, { recursive: true, force: true });
}
