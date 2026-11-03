# home-api-v1 — household home service contract

Version: `home-api-v1` · Status: draft for H1+H2+H3 integration · Owner: `infra-server`

Base URL (local default): `http://127.0.0.1:7070`. All application routes except
`/healthz`, `/readyz`, `/v1/pair`, and `/v1/sessions` require
`Authorization: Bearer <session-token>`. Identity (user/device) always derives
from the session token lookup; client-supplied user IDs or roles are never
trusted as identity. Identifiers are opaque full-UUID strings with a kind
prefix (`conv_<uuid>`, `msg_<uuid>`, `task_<uuid>`, …); clients must not parse,
truncate, or guess them.

A machine-readable schema lives beside this file at
`contracts/home-api-v1.openapi.json`. If they disagree, this markdown is
authoritative and the JSON must be fixed.

## Credential kinds (never interchangeable)

| Credential | Format | Lifetime | Where it goes |
| --- | --- | --- | --- |
| Pairing invitation secret | opaque `base64url` (256-bit) | 15 min default, single-use | `POST /v1/pair` body field `invitation_secret` |
| Device credential | `device_id` + `device_secret` | long-lived, per-device, revocable | `POST /v1/sessions` JSON body |
| Session token | `ht1_<base64url>` | 12 h, revocable via device revocation | `Authorization: Bearer` header |

Secrets are stored as SHA-256 hashes. Raw secrets are returned once at creation
and are never logged.

## Anonymous

### `GET /healthz` → 200

```json
{ "status": "ok", "installation_id": "<uuid>", "contract": "home-api-v1" }
```

Minimal readiness surface only; no user/device/data details.

### `GET /readyz` → 200 | 503

```json
{ "ready": true, "installation_id": "<uuid>" }
```

## Pairing (narrow, single-use)

Invitation is created **locally on the home host** (filesystem access is the
authorization) and is bound to one household user:

```sh
node --experimental-transform-types src/cli.mjs bootstrap --user=alice --db=data/home.sqlite
# {"installation_id":"<uuid>","user_id":"alice","invitation_id":"inv_<uuid>","invitation_secret":"...","expires_at":...}
```

### `POST /v1/pair` → 201 | 400 | 403 | 404 | 410

Request:

```json
{ "invitation_id": "inv_abc123", "invitation_secret": "<secret>", "device_label": "alice phone", "installation_id": "<optional: must match>" }
```

Success 201:

```json
{ "device_id": "dev_...", "device_secret": "<show once>", "user_id": "alice", "installation_id": "<uuid>" }
```

Failures: `400 bad_request` · `403 wrong_home | invalid_invitation` ·
`404 invitation_not_found` · `410 invitation_expired | invitation_consumed` ·
`429 rate_limited` (per-IP failed-attempt budget exceeded; `Retry-After`).
Consumption and device enrollment happen in one atomic transaction: two phones
racing one invitation enroll **at most one**; the loser gets `410
invitation_consumed`. Partial enrollment is impossible.

## Sessions (credential-authenticated, not Bearer-authenticated)

This route **mints** session tokens from a device credential; it does not
consume them. No `Authorization` header is required or checked here.

### `POST /v1/sessions` → 201 | 401

```json
{ "device_id": "dev_...", "device_secret": "<secret>" }
```

Success 201:

```json
{ "token": "ht1_...", "expires_at": 0, "user_id": "alice", "device_id": "dev_..." }
```

Revoked devices (or wrong secrets) get `401 invalid_device` and cannot renew.
Repeated failures from one IP are `429 rate_limited` (`Retry-After`); only
the direct peer is counted unless `HOME_TRUST_PROXY=1` with a loopback peer,
in which case the first `X-Forwarded-For` entry is used.

## Authenticated

### `GET /v1/me` → 200

```json
{ "user_id": "alice", "device_id": "dev_...", "installation_id": "<uuid>" }
```

### `GET /v1/devices` → 200 — own devices, no secrets

```json
{ "devices": [{ "id": "dev_...", "label": "alice phone", "created_at": 0, "revoked_at": null }] }
```

### `POST /v1/devices/:id/revoke` → 200 | 404

Revokes the device and terminates its sessions immediately; renewal is refused
afterwards. A device belonging to another user reads as `404 not_found`.

### Conversations (owner-scoped)

```http
POST /v1/conversations {"title":"Trip"}            → 201 {id, owner_id, title, created_at, updated_at}
GET  /v1/conversations                              → 200 {conversations:[...]}   (own only)
GET  /v1/conversations/:id                          → 200 | 404
```

### Messages (caller-submitted user messages only)

```http
POST /v1/conversations/:id/messages {"body":"hello"} → 201 {id, conversation_id, author_user_id, author_device_id, role:"user", body, request_key, created_at, duplicate:false}
GET  /v1/conversations/:id/messages                  → 200 {messages:[...]} (created_at,id order)
```

`role` must be `"user"` or omitted; anything else is `400 unsupported_role`
(the home persists what the caller submitted and never fabricates model
output). A conversation owned by another household user reads as `404
not_found` (no existence leak). Empty/oversize bodies are `400 bad_request`.
Missing/invalid/expired/revoked tokens are `401 unauthorized`.

Idempotent submission (H2): `request_key` is an optional client-generated UUID
for the message. First use creates the message (`201`, `duplicate:false`); a
network retry with the same key and byte-identical body+role returns the
original message (`200`, `duplicate:true`, same `id`) instead of duplicating
it; the same key with a different body+role is `409 request_key_conflict`.
Keys bind to (conversation, author): another user reusing a key gets an
independent message. Non-UUID keys are `400 bad_request`. Requests without a
key keep the original create-always behavior.

Completed task output (H3) appears in the same listing as `role:"assistant"`
messages bound to their task (`task_id`, `author_device_id:null`). The public
POST still accepts `role:"user"` only, and home-managed fields (`task_id`,
`author_user_id`, `author_device_id`) are `400 bad_request` there.

## Tasks (H2, owner- and conversation-scoped)

Tasks are persisted home runs executed by the R1 runtime bridge subprocess
(`runtime-bridge-v1`: see `agentic-framework/docs/runtime-bridge-v1.md`). The
home owns task state through the reused upstream TaskWorker (single durable
authority: queued → running → succeeded/failed/cancelled/waiting_input/
waiting_approval); the bridge is a stateless-per-run worker. No task output is
fabricated: `output`, progress, and artifacts come only from parsed bridge
events, and failures surface honestly.

```http
POST /v1/conversations/:id/tasks {"request":"summarise this","title":"Notes"}
  → 201 task view (status queued; worker may already have claimed it)
GET  /v1/conversations/:id/tasks                       → 200 {tasks:[...]} (own conversation only)
GET  /v1/tasks/:id                                     → 200 task view with progress | 404
POST /v1/tasks/:id/cancel                               → 200 cancelled view | 404 | 409 wrong_state
POST /v1/tasks/:id/inputs {"inputs":[{"id":"q1","answer":"MP4"}]}
  → 200 | 404 | 409 wrong_state                        (resumes waiting_input)
POST /v1/tasks/:id/approvals {"approvals":[{"id":"a1","decision":"approve"}]}
  → 200 | 404 | 409 wrong_state                        (resumes waiting_approval)
GET  /v1/tasks/:id/artifacts                            → 200 {artifacts:[{id,name,sha256,size,created_at}]}
GET  /v1/tasks/:id/artifacts/:artifactId                → 200 bytes (application/octet-stream) | 404
```

Task view fields: `id`, `conversation_id`, `title`, `status`, `created_at`,
`updated_at`, `attempts`, plus `error` (failed), `question(s)` (waiting_input),
`pending_approvals` (waiting_approval), `output` (succeeded bridge text),
`model` (`{provider, model}` names only), `capabilities`, `budgets`,
`artifacts[]` metadata, and `progress[]` (recent run events
`{date,kind,title}`). H6 delegation adds `parent_task_id` (null for roots),
`root_task_id`, `depth`, `children[]` (direct child ids),
`children_status[]` (`{id,status}`), and `waiting_for[]` when parked in
`waiting_children`. Conversation task lists include children (same
conversation) so existing phone lists keep working; future UI can label
`parent/root` from these fields. Workspace paths and secrets never appear
in any task or artifact response; artifact bytes are served from home
storage, never from filesystem paths. Declared artifacts are verified
(regular file, no symlinks, size and checksum match) and capped (10 MiB
each, 50 per task, 100 MiB aggregate); violations fail the task honestly.
Terminal statuses are `succeeded/failed/cancelled` plus parked
`waiting_input/waiting_approval/waiting_children` (`waiting_children`
means parked for delegated children; see `docs/runtime-task-rpc-v1.md`).

Rules:

- The conversation must exist and belong to the caller, and every task lookup
  is owner-scoped: other-household-member IDs read as `404 not_found`.
- `request` is required (1..8000 chars). `title`, `capabilities`, `budgets`
  are optional. `model`, `workspace`, `run_id`, `user_id`, `conversation_id`
  are home-managed: sending `model` is `400 model_override_denied`; the
  others are `400 bad_request`.
- When the home has no usable model, submit is `503 model_not_configured`
  (honest configuration error, no queued-but-dead tasks). A broken runtime
  command configuration is `503 runtime_not_configured`. The home selects the
  model from its own environment; clients cannot override it.
- Capabilities default narrow (`files:true`, everything denied) and every
  presented value must be a real boolean — truthy strings/numbers/objects are
  rejected, never coerced. The caller may only narrow further; grants beyond
  the home policy are `400 capability_denied`; unknown keys, non-object maps,
  and non-string egress entries are rejected the same way. Code execution
  additionally requires explicit host opt-in (`ME_RUNTIME_ALLOW_CODE_EXEC=1`)
  and runs jailed to the task workspace with `shell:false`. Budgets must be
  objects with integer values inside home maxima (`400 bad_request`).
- Progress events stream live: the home validates every bridge stdout line
  (JSON, bridge/run binding, single terminal result, byte/event caps) and
  persists progress while the child runs. Malformed, mismatched, flooded, or
  oversized output kills the child and fails the task; cancelled/taken-over
  runs cannot append further history.
- Approval IDs are namespaced per task (`<taskId>:<runtimeId>`), so identical
  runtime IDs in simultaneous tasks stay independent. Decisions are atomic
  and one-use: the task and every approval record transition together, with
  task+owner+payload binding, expiry, and replay checks — a failed check
  decides nothing (`409`, records untouched). Resume replays the runtime's
  own IDs and the exact proposed args to the bridge; capabilities are never
  widened by an approval.
- Cancelling a running task terminates its bridge child process (SIGTERM,
  then SIGKILL on a grace; shutdown never waits forever). Restarting
  the home marks orphaned runs `failed` ("not retried") instead of replaying
  uncertain external effects; waiting tasks keep their inbox state and resume
  explicitly via `inputs`/`approvals`. A home-side wall backstop kills runs
  whose runtime ignores its budget.
- Completed output is published into the authorized conversation as an
  assistant message bound to the task ID, exactly once (repeat
  callback/recovery cannot duplicate it). Failed/cancelled tasks publish no
  message. A parent with active children never publishes prematurely: a
  `completed` terminal with active children parks as `waiting_children`
  (see `docs/runtime-task-rpc-v1.md` completion policy) and publishes only
  on its final resumed `completed`.
- Delegation (H6, runtime-initiated via fd-3 `task-rpc-v1`, not phone):
  children inherit owner/conversation/model, narrow caps/budgets, and are
  bounded by `HOME_DELEGATION_MAX_FANOUT=3/MAX_DEPTH=1/MAX_TASKS_PER_ROOT=4`
  (any `0` disables; invalid values refuse start). Spawns are idempotent on `(parent,key)`; same payload
  returns the existing child, different payload is `409`. Cancel cascades
  to own-descendants only. Budgets are per-run; fanout bounds recursion
  but there is no aggregated root-cost accounting.
- Stale answer/approval/cancel transitions are `409 wrong_state`; unknown
  question/approval IDs are `400 bad_request`.

## Launch

```sh
node --version            # requires 24.18.x
node --experimental-transform-types src/cli.mjs seed-dev --db=data/home.sqlite  # DEVELOPMENT ONLY fixture users alice/bob
node --experimental-transform-types src/cli.mjs start --db=data/home.sqlite --host=127.0.0.1 --port=7070
curl http://127.0.0.1:7070/healthz
```

Task runs additionally need a home model and the R1 bridge (see
`docs/home-h2-handoff.md` for the exact environment). With neither
configured, task submit honestly returns `503 model_not_configured`.
Configure the bridge command with `ME_RUNTIME_ARGV` (JSON string array, safe
for paths with spaces; the child always spawns with `shell:false`). The
legacy `ME_RUNTIME_CMD` string is kept only for quote-free commands; anything
with quotes is rejected with `503 runtime_not_configured` at submit. Remote
providers keep their own identity and may carry a trusted
`HOME_MODEL_ENDPOINT` for a compatible API style — never relabeled as local.

## Prototype-only in H1/H2 (not production claims)

- Device-secret transport is a JSON body over loopback; production needs a
  provisioned protected endpoint (tunnel + edge admission) before LAN/WAN use.
- No account-backend coordination, hardware-backed device keys, or
  proof-of-possession pairing proofs yet — invitation secret + local bootstrap
  stands in for that handshake.
- Session tokens are opaque bearer tokens; rotation/refresh beyond re-issuing
  via `POST /v1/sessions` is not implemented.
- Revocation is enforced at the home on each request; offline-backend and
  edge-credential propagation windows are not handled here.
- Storage is single-host SQLite; backup/restore/quotas are out of scope.
