# First home-service reuse spike

## What runs

The unchanged OpenMuse `TaskWorker` and logging helper are imported from
`CopilotKit/openmuse@a4944f4c471d3dc93b8bfc060b5da309b5216ab2`. This is actual
upstream implementation, not a rewritten scheduler. Attribution, license, and
checksums are retained in `vendor/openmuse` and `THIRD_PARTY_NOTICES.md`.

Node 24 transforms the upstream TypeScript at runtime. Type-only imports are
erased, so this narrow worker slice does not require the complete upstream
application, model adapters, CopilotKit account, or database packages.

`spikes/openmuse/home-store.mjs` is a small integration adapter around Node's
built-in SQLite. It implements only the Store methods the worker consumes. This
is test glue, not the chosen production schema or a replacement for the upstream
PostgreSQL store. The production storage decision remains open.

`home-tasks.mjs` supplies synthetic owner/session inputs and a deterministic
handler. A task either asks a fixed question or creates a synthetic artifact.
This intentionally does not call a model, launch arbitrary commands, browse,
authenticate a person, or perform a real external action.

## Executed local evidence

Eight integration tests passed on Node 24.18.0 on the development Mac:

- Two users with two conversations each preserve owner-scoped task/artifact
  records while one task waits for input and others finish.
- Closing/reopening the database preserves the question and accepts an answer;
  an immediate duplicate answer does not create another run.
- Two worker/store instances racing for a queued task execute it once in this
  in-process test. This is not a claim of universal exactly-once side effects.
- A child process checkpoints a running task and exits abruptly. Another worker
  recovers its state after simulated lease expiry.
- Pending approvals do not occupy a worker slot; a resolved approval becomes
  eligible. This tests scheduling, not a real approval-enforcement boundary.
- Cancellation prevents the blocked handler's late result from overwriting it.
- A stale worker cannot checkpoint over a paused task.
- A handler failure is recorded and is not silently re-executed as queued work.

The executable demo also passed: independent Alice/Bob work completes, the home
database is reopened, and Alice's persisted waiting task resumes after her answer.
Eight separate Python tests passed for source drift detection, update staging,
immutable pins, fixed paths, and candidate-bundle validation.

The fixture trusts its owner argument. Its owner-scoped storage checks do not
establish household authentication, authorization, root-user protection, or
privacy of a full installed system. Conversation IDs are labels carried by task
inputs/artifacts, not a completed conversation/message service.

## Why this slice

The inspected worker already has persisted leases, input/approval states, events,
checkpoints, cancellation guards, and multiple eligible task execution. Reusing
it tests a concrete home-infrastructure requirement with no need to first port a
mobile app or accept a hosted thread service.

The upstream worker caps in-flight tasks at three, scans task records, keys local
active work by task ID, and does not provide Me's household fair scheduling,
resource classes, or a validated dependency DAG in this slice. It assumes task
IDs are unique across owners; our fixture uses home-generated UUIDs. Its retry
and lease behavior cannot make arbitrary external side effects exactly once.
These are review items before production adoption, not hidden implementation
claims. Keep real tool effects behind the home broker and action ledger.

## Next gates

1. Test an actual agent/model adapter against the home task contract, with honest
   model/network dependencies and completion evidence.
2. Add the phone → hosted backend → home protocol with authenticated identities,
   acknowledgments, event replay, and offline delivery behavior.
3. Build the household conversation/data service and approval broker, reusing
   existing implementations/libraries where they fit.
4. Have `setup-infra` install/pair the tested home services on a declared platform.
5. Exercise real browser/code/render workers and their isolation/resource limits.

No claim is made that the full OpenMuse app, its complete upstream typecheck,
Docker workers, phone UI, live model, hosted relay, or home installer was run.
The local npm registry was unreachable during this session; Docker was not on
PATH. This dependency-free slice was run rather than substituting invented
results for those wider integration checks.
