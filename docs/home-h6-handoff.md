# H6 integration handoff — durable subtask delegation (home half authoritative)

Companion to `docs/home-h2-handoff.md` and authoritative
`contracts/home-api-v1.md` + `docs/runtime-task-rpc-v1.md`. H6 adds bounded
durable subtask delegation without a second job engine, plus a frozen RPC
contract for the R8 runtime worker (R7 owns the agentic-framework Docker
interactive browser; this slice does not touch `runtime/`).

## What H6 delivers (infra-server only)

- Parent/root/child link records persisted in SQLite (`parentTaskId/
  rootTaskId/delegationKey/delegationHash/depth/childIds`), same
  owner+conversation inheritance, trusted home-selected model, strict
  capability/budget narrowing (child ⊆ parent ⊆ host ceiling).
- Bounded fanout/depth/root-count via host env (conservative defaults, any
  `0` disables): `HOME_DELEGATION_MAX_FANOUT=3`,
  `HOME_DELEGATION_MAX_DEPTH=1`, `HOME_DELEGATION_MAX_TASKS_PER_ROOT=4`.
  Invalid values fail closed at startup; model policy can never raise them.
  Idempotent spawn on `(parent,key)` with sha256 hash over
  request/caps/budgets/title: same hash returns existing child, different
  hash is `409 delegation_conflict`.
- fd-3 duplex JSONL RPC (`task-rpc-v1`): `submit_child/list_children/
  get_child`, owner/parent bound from the spawning closure, no global task
  lookup, `64 KiB` line / `512 KiB` buffer / `200` req caps, close on
  run end/cancel/exit. Stdin stays single-JSON-to-EOF
  (`runtime-bridge-v1` compatible); `ME_HOME_TASK_RPC_FD=3` is the only new
  env. Legacy bridges ignoring fd 3 are unaffected.
- Durable `waiting_children` status + `childIds/resume.childResults`,
  wake via worker `settled` hook + startup reconciliation CAS (no LLM
  polling), single-CAS exactly-once wake. `waiting_input` parents may also
  have children; child settle never auto-resumes a human wait. Premature
  `completed` with active children is held as `waiting_children` (no
  conversation publish until truly final). Restart fail-closes `running`
  as today; `waiting_children` parents reconcile without replaying
  completed actions; orphans under failed parents cancel closed.
- Explicit cancel cascade over own-descendants only (owner-scoped BFS,
  cycle-safe). Child ask/approval/cancel/artifacts reuse existing
  `task_id`-namespaced flows.
- Views: `parent_task_id/root_task_id/depth/children[]/children_status[]/
  waiting_for` on task views; conversation task lists include children
  (same conversation). Budgets are per-run; fanout bounds recursion but
  there is no aggregated root-cost accounting. No primary-planner claim.

## For the consumers

- `phone-app`: render `parent_task_id/root_task_id/children` when present;
  existing `GET /v1/conversations/:id/tasks` already lists children.
  `waiting_children` is a parked state like `waiting_input` (poll for
  `queued/running/succeeded`). No new auth.
- `backend-server/setup-infra`: preserve SQLite + tasks root as before;
  optionally set the three `HOME_DELEGATION_*` vars (defaults apply).
- `agentic-framework` R8: implement `docs/runtime-task-rpc-v1.md`
  verbatim — open fd from `ME_HOME_TASK_RPC_FD`, JSONL `submit_child`,
  return `waiting_children`, resume on `op: resume` with `child_results`,
  then final `completed`. Do not invent planning/scheduling outside the
  maintained LangGraph harness; do not widen caps; surface denials
  honestly. Docker code never inherits fd 3.

## What H6 does not claim

- The current home fixture bridges prove transport/lifecycle only, not
  live-model delegation. Full runtime integration is R8's job against the
  published contract; this slice does not pretend the current Python
  runtime already delegates.
- Single-host SQLite, loopback default, no quotas/backups beyond H2/H5.
