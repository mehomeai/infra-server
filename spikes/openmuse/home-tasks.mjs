import { randomUUID } from 'node:crypto';
import { TaskWorker } from '../../vendor/openmuse/apps/server/src/engine/worker.ts';

export { TaskWorker };

// A trusted owner/session is supplied by the test harness, not authenticated
// here. Real backend/home identity verification is a separate integration gate.
export async function submit(store, owner, conversationId, prompt, input = {}) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(), title: 'Synthetic integration task', prompt, kind: 'agent',
    status: 'queued', plan: [], evidence: [],
    input: { ...input, conversationId }, state: {},
    createdAt: now, updatedAt: now, attempts: 0,
    leaseId: null, leaseUntil: null, artifactIds: [],
  };
  await store.put(owner, 'tasks', task);
  return task;
}

export async function answer(store, owner, taskId, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Answer required');
  const task = await store.get(owner, 'tasks', taskId);
  if (!task) throw new Error('Task not found');
  return store.compareAndSwap(owner, 'tasks', taskId, { status: 'waiting_input' }, {
    status: 'queued', input: { ...task.input, answer: value }, question: null,
  });
}

// Deterministic fixture: deliberately no model calls, shell execution, browser,
// external service, or simulated claim that this is a general-purpose agent.
export async function fixtureHandler(store, owner, task, context) {
  if (task.input.needsAnswer && !task.input.answer) {
    await context.event('status', 'Waiting for an answer');
    return { status: 'waiting_input', question: 'Which format should I use?' };
  }
  await context.guard();
  const artifact = {
    id: randomUUID(), taskId: task.id, conversationId: task.input.conversationId,
    text: `${task.prompt}${task.input.answer ? ` (${task.input.answer})` : ''}`,
  };
  await store.put(owner, 'artifacts', artifact);
  await context.event('result', 'Synthetic artifact saved');
  return { status: 'succeeded', artifactIds: [artifact.id], result: artifact.text };
}

export function fixtureWorker(store, options = {}) {
  return new TaskWorker(store, (owner, task, context) =>
    fixtureHandler(store, owner, task, context), options);
}
