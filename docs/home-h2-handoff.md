# H2 integration handoff — persisted agent tasks

Companion to `docs/home-h1-handoff.md` (pairing/identity/conversations) and the
authoritative `contracts/home-api-v1.md`. H2 adds: hardened storage
(0700 data dir / 0600 database files, FK enforcement, schema-version gating
with v1→v2 migration), full-UUID identifiers, idempotent message submission,
and a persisted task API executed through the R1 runtime bridge.

## Runtime requirements for task execution

The home service spawns one R1 bridge subprocess per task run
(`runtime-bridge-v1`: `agentic-framework/docs/runtime-bridge-v1.md`). The
bridge program is resolved from the home host environment:

```sh
# Production: R1's venv bridge (R1 owns that path; do not create it from here)
export ME_RUNTIME_CMD="/Users/kgensupertramp/Desktop/me/agentic-framework/.venv/bin/python -m me_runtime.bridge"
export ME_RUNTIME_CWD="/Users/kgensupertramp/Desktop/me/agentic-framework"   # optional
npm run start:home
```

The R1 bridge implementation is not present yet — only its contract is. Until
it lands, task submit/run/answer/approve/cancel/recovery logic is fully wired
against the contract and verified with the explicitly labeled offline fixture
`test/fixture-bridge.mjs` (used only when the home selects
`provider:fixture`; see below). No R1 files were touched.

Model selection is home-side only (clients can never override it):

```sh
export HOME_MODEL_PROVIDER=local                        # local-first default
export HOME_MODEL_NAME=llama3.1                         # optional
export HOME_MODEL_ENDPOINT=http://127.0.0.1:11434  # optional (native Ollama API; default)
# explicit remote opt-in only:
export HOME_MODEL_PROVIDER=openai ME_RUNTIME_ALLOW_REMOTE=1
export ME_RUNTIME_MODEL_API_KEY="..."                   # never in requests/logs
# fixture (development/tests ONLY):
export HOME_MODEL_PROVIDER=fixture HOME_ALLOW_FIXTURE_MODEL=1
```

With no usable model, `POST .../tasks` returns `503 model_not_configured`
instead of queueing dead work. Capability ceiling (narrow by default):

```sh
export HOME_CAP_WEB_FETCH=1 HOME_CAP_EGRESS="example.com"  # optional egress
export HOME_CAP_BROWSER=1 HOME_CAP_ANIMATION=1              # optional workers
export HOME_CAP_CODE_EXEC=1 ME_RUNTIME_ALLOW_CODE_EXEC=1   # bounded code exec
export HOME_TASKS_ROOT=/path/for/task/workspaces           # default <dbdir>/tasks
export HOME_POLL_MS=1000                                    # worker tick
```

## For the consumers

- `phone-app` (F1): submit via `POST /v1/conversations/:id/tasks`
  `{request, title?, capabilities? (narrow-only), budgets? (clamped)}`; poll
  `GET /v1/tasks/:id` for `status`/`progress`; answer `waiting_input` via
  `POST .../inputs`, decide `awaiting_approval` via `POST .../approvals`,
  stop via `POST .../cancel`; fetch `output` and `artifacts[]` (bytes from
  `.../artifacts/:artifactId`). Expect `503` when the home has no model and
  `404` for other users' resources. Send `request_key` (UUID) with messages to
  survive network retries without duplicates.
- `backend-server`: still no coordination endpoint in this slice.
- `setup-infra` (S1): preserve the SQLite file AND the tasks root across
  upgrades; provision the R1 venv/bridge path, Ollama/remote model env, and
  the optional worker dependencies (Playwright/Chromium, ffmpeg). Task
  workspaces live under `<dbdir>/tasks` by default.
- `agentic-framework` (R1): the home invokes your `runtime-bridge-v1`
  contract verbatim (run/resume, trusted run/user/conversation/workspace,
  narrow capabilities, workspace jailing, JSONL events, exit codes) and maps
  terminal `completed|failed|cancelled|waiting_input|awaiting_approval` onto
  the home lifecycle. Recovery: the home never re-invokes an interrupted run
  blindly — orphaned runs are marked failed, waiting runs resume explicitly.

## H3 changes (read first if you integrate tasks)

- **Public approval IDs are namespaced per task** (`<taskId>:<runtimeId>`).
  Decide with the exact public ID from `pending_approvals`; the home maps
  back to runtime IDs and replays the exact proposed args on resume.
  Question IDs stay as the runtime issued them (task-scoped already).
- **Completed tasks publish an assistant message** into their conversation
  (`role:"assistant"`, `task_id` set, exactly once). Phone clients must render
  these as the real exchange — they are bridge output, not user input. Message
  POST still accepts `role:"user"` only; `task_id`/`author_*` are rejected.
- **Runtime command**: prefer `ME_RUNTIME_ARGV='["/path/with spaces/python","-m","me_runtime.bridge"]'`;
  `ME_RUNTIME_CMD` remains only for quote-free commands. Remote providers may
  set `HOME_MODEL_ENDPOINT` for a compatible endpoint; provider identity is
  never rewritten.
- **Capability requests must use real booleans**; truthy strings/numbers are
  rejected, as are non-object capability/budget maps and unknown fields.
- Progress is live (visible while the run executes); a second terminal
  result, wrong run binding, or malformed/flooded stdout kills the run.
  Approval decisions are atomic and one-use with expiry/binding checks.
- H5 supervision: bounded child termination (SIGTERM→SIGKILL escalation,
  capped waits), home wall backstop over runtime budgets, bounded broker/HTTP
  shutdown; failed pair/session attempts are per-IP rate limited (429);
  artifacts are verified (O_NOFOLLOW, regular-file, size-first bounded read,
  realpath containment) and capped (10 MiB each, 50/task, 100 MiB aggregate).

R1 status: the actual `me_runtime.bridge` implementation now exists and the
home integration suite (`test/home-r2.test.mjs`) drives it with fixture
models only. Fixture-model runs prove the subprocess contract path, not
live-model quality.

## What H2/H3 does not claim

Single-host SQLite (WAL) with no backup/restore/quotas; loopback-only default
bind retained; approval expiry relies on far-future action TTLs (no
administrative expiry UX); fair scheduling beyond the reused worker's
3-in-flight cap is out of scope; browser/animation prerequisites report
honestly through the bridge when missing.
