# home-notifications-v1 — opt-in private task push contract

Version: `home-notifications-v1` · Status: ready for native phone F8 · Owner: `infra-server`

Companion to authoritative `contracts/home-api-v1.md` (pairing/sessions/tasks).
This file is the **stable contract** the native phone (Expo Notifications SDK 58)
implements against. The home never creates real push resources; this slice is
offline-testable with a fake provider and makes zero outbound network calls
unless the operator opts in.

## Principles (non-negotiable)

- **Opt-in both sides.** Home default: notifications **disabled**, no outbound
  network. Delivery requires operator opt-in (`HOME_NOTIFICATIONS_ENABLED=1`,
  optional `HOME_EXPO_PROJECT_ID` / `HOME_EXPO_ACCESS_TOKEN`) **and** per-phone
  consent (`permission_enabled:true` on register, i.e. the user granted OS
  notification permission). Either side off → no send, no network.
- **Metadata only.** Push payload `data` carries only
  `installation_id / task_id / device_id / kind / event_id`. Title/body are
  generic (`Action needed` / `Task finished` / `Task update`). **Never** sent:
  conversation titles, user questions/answers, task output/errors, artifact
  bytes, browser data, credentials, or URLs. The home hosts private history;
  there is no cloud chat relay.
- **Fixed origin only.** Production sends to the single fixed Expo origin
  `https://exp.host` (`/--/api/v2/push/send`, receipts
  `/--/api/v2/push/getReceipts`). No client-supplied webhook URLs (no SSRF
  surface). Redirects are refused, never followed, so the provider bearer
  token and push addresses cannot be forwarded elsewhere; every response is
  origin- and status-checked and parsed with a hard byte cap. No global Me
  APNs developer key on home or phone. The public Expo Project ID is app
  config; provider credentials (if any) are operator-entered on the home
  host only (`HOME_EXPO_ACCESS_TOKEN` env, never stored in SQLite, never
  returned over HTTP, never logged, never passed to the runtime bridge
  child — see below).
- **Device-me identity.** Every route requires `Authorization: Bearer <session-token>`.
  Identity (user/device) derives from the session lookup. `user_id`/`device_id`/
  `installation_id` in a register body are `400 bad_request` (home-managed).
  Tokens are scoped to the **session device + user**; cross-owner or
  cross-device access reads as `404`/`400` and never leaks the token.
- **Revocation stops delivery.** Device revoke terminates sessions and disables
  the push binding immediately. If the same push address is re-registered by a
  newly paired device, the old binding is atomically deactivated so a previous
  household user never receives the new phone's alerts.

## Authenticated routes (all `Bearer` session)

### `POST /v1/notifications/register` → 200 | 400 | 401 | 403 | 429

Request (device-me; no IDs accepted):

```json
{
  "expo_push_token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "provider": "expo",
  "permission_enabled": true
}
```

- `expo_push_token`: required, strict `ExponentPushToken[...]` /
  `ExpoPushToken[...]`, max 256 chars.
- `provider`: optional, must be `"expo"` when present (only provider supported).
- `permission_enabled`: required boolean — the phone's current OS permission
  state. `false` stores the binding as disabled (no delivery) until the user
  grants permission and re-registers with `true`.
- `project_id` (optional, ≤128 chars) is accepted for forward-compat and ignored
  by the home; never a credential.

Success 200:

```json
{
  "registered": true,
  "enabled": true,
  "provider": "expo",
  "permission_enabled": true,
  "installation_id": "<uuid>"
}
```

Failures: `400 bad_request | invalid_push_token` (strict format, home-managed
fields, non-boolean permission) · `401 unauthorized` (bad session) ·
`403 notifications_disabled` (operator has not enabled pushes on this home) ·
`429 registration_limit` (max 10 active bindings per user; `Retry-After: 60`).
The raw token is **never** returned; status exposes only a `token_suffix`.

### `GET /v1/notifications/status` → 200 (also `GET /v1/notifications`)

```json
{
  "registered": true,
  "enabled": true,
  "provider": "expo",
  "permission_enabled": true,
  "token_suffix": "…abcd1234",
  "created_at": 0,
  "updated_at": 0,
  "installation_id": "<uuid>"
}
```

Unregistered devices get `{registered:false, enabled:false, ...}`. Never
contains the raw token.

### `POST /v1/notifications/disable` → 200 (also `/v1/notifications/unregister`)

Idempotent; deactivates the **session device** binding only:

```json
{ "disabled": true }
```

## Outbox semantics (home-side, phone-visible behavior)

- SQLite outbox with `UNIQUE(event_id, device_id)` — at-least-once, crash-safe.
  Stable `event_id = <taskId>:<status>:<updatedAt>`; the phone **must dedupe**
  on `event_id` (duplicate deliveries are possible after a home restart).
- Human-wait alerts (`waiting_input`, `waiting_approval`) fire for **any
  owned task, roots and delegated children**: a child asking while the phone
  is closed must still alert, or the workflow stalls silently. Completion
  alerts (`completed`/`failed`/`cancelled`) stay **root-only** (no
  completion-storm; the parent aggregates).
- Enqueue happens in the worker `settled` hook chain (H6 cancel/wake behavior
  preserved) and on explicit root cancel. Enqueue is synchronous SQLite;
  **network failure never fails the task**.
- Before **send**, the home revalidates: registration still active +
  permission on, device still paired/unrevoked/owned, and the task still in
  the **same** pending/terminal status. Answered or revoked rows **drop**
  silently (generic payload means even a stale delivery leaks nothing).
- Durable delivery lease: each pump claims due rows queued → sending under a
  lease id (compare-and-swap), so concurrent pumps — even two processes on
  one DB — send exactly once. Pumps serialize per service; stale provider
  responses are fenced by lease id and cannot mark rows claimed under a newer
  lease. Expired leases recover to queued on the next pump/boot.
- Bounded delivery: batch (default 10), retry with backoff + jitter
  (default 8 attempts, base 5 s, cap 15 min), per-row expiry (default 24 h),
  global pending cap (500, oldest dropped first). `DeviceNotRegistered` on a
  send ticket disables the binding immediately. No unbounded loops,
  no request logging (method + path + status only).
- Bounded timeouts (default 8 s, covering headers + capped body parse) and
  bounded shutdown: stop aborts in-flight sends and awaits the pump, so no
  provider callback writes after the DB closes; restart resumes pending rows
  and pending receipts.
- Delayed receipts: a ticket acceptance marks the row **sent** immediately
  and schedules a later receipt poll (Expo receipts arrive after send).
  Missing receipts retry bounded with expiry; terminal receipt errors
  (`DeviceNotRegistered`) disable the binding for future rows. An accepted
  notification is **never resent**. Retention prunes old sent/dropped rows
  (default 7 d / 2000 rows, bounded per pump); task history is never pruned.

## Push payload (exact shape the phone receives)

```json
{
  "to": "ExponentPushToken[redacted-on-home]",
  "title": "Action needed",
  "body": "Your task needs your input. Open the app to continue.",
  "data": {
    "installation_id": "<uuid>",
    "task_id": "task_<uuid>",
    "device_id": "dev_<uuid>",
    "kind": "waiting_input",
    "event_id": "task_<uuid>:waiting_input:<updatedAt>"
  }
}
```

`kind ∈ waiting_input | waiting_approval | completed | failed | cancelled`.
Titles/bodies are the fixed generic strings in `src/notifications.mjs`
(`genericCopy`). No `url`, no conversation/task text.

## Native phone flow (F8, Expo Notifications SDK 58)

1. On first launch (and after account logout/login), request OS permission via
   the SDK. If denied, register with `permission_enabled:false` (or skip) and
   do not schedule local handlers that assume delivery.
2. Get the Expo push token with the **app's configured public Project ID**
   (`getExpoPushTokenAsync({ projectId })` — project ID is app config, never
   a home credential).
3. `POST /v1/notifications/register` on the **currently paired home** with the
   session token: `{expo_push_token, provider:"expo", permission_enabled}`.
   Persist nothing sensitive beyond the suffix for debug UI.
4. On notification tap: **do not navigate from push data**. First verify the
   tap's `installation_id` matches the currently paired home **and**
   `device_id` matches this device; if either mismatches, drop the tap
   (stale install / remapped address — prevents private leaks after logout or
   re-pair). Then `GET /v1/tasks/:task_id` on the current home and render
   from the **fetched task + conversation** (which includes `conversation_id`),
   never from push text.
5. Dedupe by `event_id` (in-memory + persisted cache): ignore repeats.
6. On account logout: call `POST /v1/notifications/disable` best-effort (the
   home may be offline — treat as untrusted), clear local handlers and the
   duplicate cache, and re-register only after the next successful pair.
7. Model tools never configure tokens; push addresses never pass through task
   inputs/approvals.

## Operator config

```sh
HOME_NOTIFICATIONS_ENABLED=1            # required opt-in; default off
HOME_EXPO_PROJECT_ID="<expo-project-id>" # optional public id, informational
HOME_EXPO_ACCESS_TOKEN="<token>"         # optional, memory-only, never stored
HOME_NOTIF_MAX_ATTEMPTS=8 HOME_NOTIF_BASE_DELAY_MS=5000
HOME_NOTIF_MAX_DELAY_MS=900000 HOME_NOTIF_BATCH_SIZE=10
HOME_NOTIF_SEND_TIMEOUT_MS=8000 HOME_NOTIF_EXPIRY_MS=86400000
HOME_NOTIF_PUMP_MS=15000
HOME_NOTIF_LEASE_MS=60000 HOME_NOTIF_RECEIPT_DELAY_MS=30000
HOME_NOTIF_RECEIPT_MAX_ATTEMPTS=10 HOME_NOTIF_RECEIPT_BATCH=50
HOME_NOTIF_RETENTION_MS=604800000 HOME_NOTIF_MAX_ROWS=2000
```

With the flag off, register returns `403 notifications_disabled` and the home
makes zero outbound connections (verified by the disabled-mode test).

## Runtime bridge environment (H7.1)

The task runtime bridge child no longer inherits the host env. It receives a
curated env: functional plumbing (PATH/HOME/tmp/locale/certs/proxies), the
runtime's own `ME_RUNTIME_*` execution opts (secret-looking names cross only
as the trusted `model.api_key_env` value named by the home-selected model),
and the fd-3 task-RPC binding. Host push/admin secrets
(`HOME_EXPO_ACCESS_TOKEN`, `HOME_NOTIFICATIONS_*`, SSH/AWS/tunnel keys) never
cross into the LLM runtime or generated code. This is secret exclusion, not a
sandbox claim; the `task-rpc-v1` / FD3 contract itself is unchanged (R8 worker
untouched).

## What this slice does not do

- No APNs key provisioning, no real Expo/public push resources, no cloud relay.
- No per-task content in pushes; task detail (`GET /v1/tasks/:id`, which
  includes `conversation_id`) remains the single source of truth.
- No changes to the frozen `task-rpc-v1` / FD3 parent-child contract (R8
  worker untouched).
- Register/status/disable shapes and the push `data` fields are frozen for
  the F8 phone consumer.
