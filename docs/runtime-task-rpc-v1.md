# task-rpc-v1 — home subtask delegation RPC (home authoritative, for R8 runtime)

Version: `task-rpc-v1` · Status: implemented on home side (H6) · Owner: `infra-server`
Consumer: `agentic-framework` R8 worker (Python `me_runtime.bridge` successor).

Home is the single durable authority: the reused upstream `TaskWorker`
owns every claim/lease/settle. This RPC only creates normal task records
through the same worker; there is no second job engine and no vendor patch.

## 1. Transport (stdin unchanged)

- Node home spawns the bridge with `stdio: ['pipe','pipe','pipe','pipe']`
  and `env.ME_HOME_TASK_RPC_FD=3`.
- Main stdin is still exactly one JSON object (`runtime-bridge-v1` request)
  read to EOF. The runtime must not change stdin framing.
- fd 3 is a duplex JSONL stream owned by the child process (no auth secret:
  possession of the fd is the capability). Generated Docker code never
  inherits it (container has no home fds).
- Legacy bridges that never open fd 3 are unaffected: home sees zero RPC
  requests and settles normally. Node `fixture-bridge.mjs` proves this.
- Bounds (home-enforced, runtime must also bound its writer):
  `64 KiB` max RPC line (UTF-8 bytes), `512 KiB` max buffered without
  newline, `200` requests per run, `32 KiB` max params object,
  `128 KiB` max response, `256 KiB` max pending socket writes.
  IDs must be short strings (`1..128` chars) or safe integers; methods
  `1..64` chars; params must be objects. The request budget is terminal:
  the 201st request gets one `delegation_denied` error and the pipe
  closes — a runaway runtime cannot wedge the home with unlimited errors.
  Oversize/flooded input closes the pipe, never unbounded buffering. The
  pipe closes on run end, cancel, lease takeover, or child exit. Split
  UTF-8 sequences across chunks are decoded safely; partial lines buffer
  until newline and batched lines parse in order. Error responses carry
  only `code` + short message — never request contents, credentials, or
  logs. Lease binding: every call re-validates the spawning lease
  (`status=running` + `leaseId` match + not aborted); a stale fd after a
  worker takeover is denied with `wrong_state`.

## 2. Envelope

Request (runtime → home, `\n` terminated):

```json
{"rpc":"task-rpc-v1","id":1,"method":"submit_child","params":{"key":"plan-1","request":"research X","title":"X","capabilities":{"files":true},"budgets":{"max_steps":4}}}
{"rpc":"task-rpc-v1","id":2,"method":"list_children","params":{}}
{"rpc":"task-rpc-v1","id":3,"method":"get_child","params":{"id":"task_..."}}
```

Response (home → runtime):

```json
{"rpc":"task-rpc-v1","id":1,"ok":true,"result":{"child":{"id":"task_...","status":"queued","parent_task_id":"task_...","root_task_id":"task_..."}}}
{"rpc":"task-rpc-v1","id":2,"ok":true,"result":{"children":[{"id":"task_...","status":"succeeded"}]}}
{"rpc":"task-rpc-v1","id":1,"ok":false,"error":{"code":"delegation_denied","message":"..."}}
```

Error codes: `bad_request` (shape/validation), `capability_denied`
(narrowing violation), `delegation_denied` (disabled/fanout/depth/root-count),
`delegation_conflict` (same key, different payload), `not_found`
(unknown child id), `wrong_state` (parent no longer running).

## 3. Methods

### `submit_child` — spawn one independent research subtask

Params:

- `key` (required, `1..128` chars): idempotency key scoped to
  `(parent_task_id, key)`. Same key + byte-identical
  `request/capabilities/budgets/title` hash returns the existing child
  (retry/resume safe). Same key + different hash is `409
  delegation_conflict`.
- `request` (required, `1..8000` chars): child prompt.
- `title` (optional, ≤200 chars).
- `capabilities` (optional object): must narrow the parent. Every `true`
  must already be `true` on the parent; `network_egress_allowlist` must be a
  subset of the parent's. Strict booleans only; unknown keys rejected.
  No `model` field is accepted from the bridge or the phone — the home
  inherits `model` from the parent (trusted host selection).
- `budgets` (optional object): each of `max_steps/max_wall_seconds/
  max_tool_calls` must be a positive int and `<=` the parent's value (and
  `<=` home maxima). This is per-run, not aggregated root accounting.

Binding (home-enforced regardless of model):

- `owner`, `conversation_id`, `model` inherit from the parent closure.
  Request `user_id/conversation_id/model/workspace/run_id` fields are never
  trusted and are not part of this RPC.
- New child: `parent_task_id=parent`, `root_task_id=parent.root`,
  `depth=parent.depth+1`, same conversation (so existing phone
  `GET /v1/conversations/:id/tasks` lists children), independent workspace
  `tasks/<childId>`, independent `task_id`-namespaced approval IDs and
  artifact scope. No cross-owner/cross-conversation links possible;
  cycles impossible (child id is fresh).
- Host bounds (conservative defaults; any `0` disables spawning entirely):
  `HOME_DELEGATION_MAX_FANOUT=3` per parent,
  `HOME_DELEGATION_MAX_DEPTH=1`,
  `HOME_DELEGATION_MAX_TASKS_PER_ROOT=4`.
  Invalid values fail closed at startup (refuse start) rather than falling
  open to widened defaults, and model policy can never raise these bounds.
  Exceeding any is `delegation_denied`. The runtime must not implement its
  own recursive bomb: if home denies, surface honestly and continue without
  that child. Allocation is single-authority serialized (mutex + SQLite
  IMMEDIATE transaction re-validating parent status/lease, idempotency,
  fanout, and root-count atomically), so concurrent same-key spawns yield
  exactly one child and races near caps cannot overshoot.

### `list_children` — direct children of this parent only

Returns `children[]` summaries (`id/status/parent_task_id/root_task_id/
depth`). Never a global task lookup.

### `get_child` — one direct child only

`params.id` must be a direct child of the calling parent and same owner;
otherwise `not_found` (no oracle, no cross-task read).

## 4. Bridge result extension (`runtime-bridge-v1` compatible)

New terminal `result.status`:

- `waiting_children` with optional `children: [ids]` (or `child_ids`).
  Home verifies every declared id is a known direct child; unknown →
  `failed`. If no children exist → `failed`. If all children already
  terminal, home requeues immediately with `child_results` (no extra idle
  cycle). Otherwise the parent parks as `waiting_children` with
  `childIds` + `state.waitingChildren`.

Completion policy (R8 must implement exactly this):

1. Return `waiting_children` when pausing for delegated work. Do not return
   `completed` with active children — if you do, home holds the run as
   `waiting_children` anyway and withholds the conversation publish.
2. A `completed` terminal publishes to the conversation **only** when zero
   active children remain. Active = any child in
   `queued/running/waiting_input/waiting_approval/waiting_children`.
3. Wake resume is `op: resume` with the same `run_id/workspace` plus
   `child_results` (see §5). The harness checkpoint (`graph.db`/
   `pending.json`) continues; completed tool calls are never replayed.
   `child_results` are trusted home summaries, not user input.
4. `waiting_input`/`awaiting_approval` parents may also have children.
   Children run independently; their settle never auto-resumes a human
   wait. Only `waiting_children` is woken by child settle.
5. `failed`/`cancelled` on ANY task (terminal result or worker-level
   failure such as malformed stdout, crash, or wall timeout) cascade-cancels
   own-descendants (owner-scoped BFS). Cancel via `POST /v1/tasks/:id/cancel`
   does the same. The settled hook performs the cascade so catch-path
   failures that bypass `settleTerminal` still clean up; other roots and
   other owners are unaffected.

## 5. Resume `child_results` shape (home → runtime on `op: resume`)

```json
{
  "op": "resume",
  "run_id": "task_parent",
  "child_results": [
    {"id":"task_c1","status":"succeeded","output":"...≤2000 chars","artifacts":[{"id":"art_...","name":"output/x.md","sha256":"...","size":123}]},
    {"id":"task_c2","status":"failed","error":"...≤2000 chars"},
    {"id":"task_c3","status":"cancelled"}
  ]
}
```

Only short summaries + scoped artifact metadata. No workspace paths, no
full logs. Private child logs stay home. The runtime aggregates these into
its final output (LangGraph continue/checkpoint) and then returns a final
`completed`/`failed`.

## 6. Wake guarantees (home-side, no LLM polling)

- The worker's `settled` hook fires after every child settle. If the parent
  is `waiting_children` and every direct child is terminal
  (`succeeded/failed/cancelled`), home CAS-transitions the parent
  `waiting_children → queued` with `resume.childResults`.
- Single-CAS wake: concurrent settling children race one CAS; exactly one
  wins, the other sees `queued` and does nothing. No duplicate resumes.
- Startup reconciliation (`reconcileWaitingParents`) does the same CAS scan
  after `recoverInterrupted`. Restart fail-closes active (`running`) runs
  as `failed` (uncertain external effects, never replayed); waiting parents
  reconcile settled children (including newly-failed ones) without replaying
  completed tool calls. Queued children orphaned under a terminal
  failed/cancelled parent are cancelled closed.
- `waiting_children` never occupies a worker in-flight slot, so parked
  parents cannot stall other jobs. The 3-in-flight cap still bounds
  concurrently running tasks (parent + children count while running).

## 7. What this RPC is not

- No model override, no capability widening, no global task read, no cost
  aggregation. Budgets are per-run; fanout/depth/root-count bound recursion
  but do not claim root-cost accounting.
- No fake primary planner: home never plans; the R8 agent loop (LangGraph
  prebuilt ReAct) owns planning. Fixture bridges prove transport only.
