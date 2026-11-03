import { HomeStore } from './home-store.mjs';
import { submit, TaskWorker } from './home-tasks.mjs';

const store = new HomeStore(process.argv[2]);
const task = await submit(store, 'alice', 'chat-a', 'Recover this task');
const worker = new TaskWorker(store, async (_owner, _task, context) => {
  await context.checkpoint({ state: { stage: 'checkpoint-before-crash' } });
  process.stdout.write(`${task.id}\n`, () => process.exit(77));
  await new Promise(() => {});
});
await worker.tick();
