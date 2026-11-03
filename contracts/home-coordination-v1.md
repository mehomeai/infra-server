# home-coordination-v1 — home ↔ hosted-backend coordination contract

Version: `home-coordinator-v1` (file) over `home-api-v1` (wire) · Status: implemented (H8) · Owner: `infra-server`

Source reality: the hosted backend owns the wire (`backend-server/docs/home-activation-v1.md` B7 + `docs/backend-api-v1.md` B4). This file owns only the home side: credential-file schema, env keys, heartbeat payloads, and failure states. Where they disagree on backend behavior, the backend docs win; where they disagree on the home file, this markdown wins.

Backend B7 publishes ticket-only `POST /v1/homes/activate` + account activation tickets. The home never sees an account JWT. Existing B1 `POST /v1/homes/register` heartbeat path is retained for local-dev compat and is used by tests the same way.

## 1. Private credentials file (S7 writes, H8 reads)

Path: operator-chosen absolute file outside git and outside shared config, e.g. `~/.me-home/coordinator.json`. Env: `HOME_COORDINATOR_CREDENTIALS_FILE=<absolute private file>`. Default unset = DISABLED with zero outbound network.

S7 redeems the one-time activation ticket over HTTPS with `redirect: 'error'` (credential requests NEVER follow redirects, not even to `https://`; a redirect is a failure); send NO account JWT from the home, then writes this file `0600` outside git, never logs the secret, never ships it to the phone.

```json
{
  "protocol": "home-coordinator-v1",
  "backend_url": "https://backend.example.test",
  "home_id": "home_…",
  "installation_id": "123e4567-…",
  "home_token": "me_home_…",
  "endpoint_hint": "https://home.example.test",
  "protocol_version": "home-api-v1"
}
```

Schema (exact, frozen):

| Field | Type | Rule |
| --- | --- | --- |
| `protocol` | string | MUST equal `home-coordinator-v1` |
| `backend_url` | string 1..500 | valid URL, no userinfo/query/fragment. `https:` always; `http:` ONLY for loopback hosts (`127.0.0.1`, `localhost`, `::1`) with explicit `HOME_COORDINATOR_ALLOW_HTTP_LOOPBACK=1`. Path normalization allowed. |
| `home_id` | string | `^[a-z0-9][a-z0-9_-]{2,63}$` (backend homeId) |
| `installation_id` | string | printable ASCII 1..128, MUST equal the actual home DB `installation_id` (`GET /healthz`), else `wrong_home`. Start loopback once (or bootstrap the initial DB) so SQLite mints this REAL id — the fresh-setup reserved config UUID is NOT usable for prepare/activate |
| `home_token` | string | `^me_home_[A-Za-z0-9_-]{32,128}$` (opaque, shown once at activation) |
| `endpoint_hint` | string 1..500 | public home base URL, same `https:` / loopback-`http:` gate as `backend_url`, no userinfo/query/fragment. Trusted local config only; sent as `endpointHint` in heartbeats. |
| `protocol_version` | string | MUST equal `home-api-v1` |

No extra keys. File gates: absolute path, final component MUST NOT be a symlink, MUST be a regular file, size `1..16 KiB`, mode owner-only (`(mode & 0o077) === 0`, i.e. `0600`-style). Violations, JSON errors, or `installation_id` mismatch = configured component error, NO network. Error codes are generic (`invalid_credentials_format`, `invalid_credentials_permissions`, `wrong_home`, …); values/secrets/paths/contents are never echoed or logged.

Deletion: if the file is deleted (e.g. after a full restore), the coordinator reports `configuration_error` and stops all network. A fresh activation (new ticket → new `home_token` → new file) is required. Replaying an old ticket MUST report `410` and MUST NOT resurrect the old credential.

No account JWT, SSH, provider secrets, or global Me credentials live at the home.

## 2. Env keys

| Key | Default | Meaning |
| --- | --- | --- |
| `HOME_COORDINATOR_CREDENTIALS_FILE` | unset (DISABLED) | absolute private file above |
| `HOME_COORDINATOR_INTERVAL_MS` | `60000` | heartbeat period, bounded `5000..600000`, plus backoff/jitter (max backoff 5 min) |
| `HOME_COORDINATOR_TIMEOUT_MS` | `8000` | per-attempt fetch+body timeout, bounded `1000..30000` |
| `HOME_COORDINATOR_ALLOW_HTTP_LOOPBACK` | unset (false) | `1`/`true` allows `http://` loopback `backend_url`/`endpoint_hint` for explicit dev/test only |

`HOME_*` (including `HOME_COORDINATOR_*`) never crosses into runtime bridge children (`buildRuntimeEnv` exclusion, H7.1). The only model secret a child ever sees is the home-selected `model.api_key_env` value.

## 3. HTTP payloads (HomeToken auth only)

Heartbeat (existing backend route, home-self only):

```http
POST {backend_url}/v1/homes/:homeId/heartbeat
Authorization: Bearer <home_token>
Content-Type: application/json

{"status":"online","endpointHint":"<from file>","installationId":"<from file>"}
```

- `Authorization: Bearer <home_token>` for that exact `homeId`. Account bearers → `403`; missing → `401`; wrong home's token → `403`.
- `redirect: 'error'` — redirects are failures, never followed; no cached tokens forwarded cross-origin. Final origin MUST equal the configured `backend_url` origin.
- Timeout + `AbortController` covers headers AND bounded response body (`64 KiB` max).
- Success `200`: `{ok, homeId, lastSeenAt, lastStatus}`. The backend response NEVER changes the private home URL, model, or auth config; liveness observations only.
- Endpoint updates use this same route (`endpointHint`/`installationId` rebind, home-token-gated). No separate endpoint-update route is invented here.
- Status read (phone/operator discovery, not used by the home loop): `GET /v1/homes/:homeId/status` (member or home-self) → `{homeId, lastSeenAt, lastStatus, online, staleAfterSeconds}`. `online` is server-computed (heartbeat within `ME_BACKEND_STALE_AFTER_SECONDS`); never-heartbeated/stale = `offline`.

Local coordinator status (authenticated, redacted):

```http
GET /v1/coordinator/status  (Bearer session token)
→ 200 {configured, enabled, status, homeId:"home_abc…wxyz"|null,
       lastHeartbeat:{at,lastSeenAt,lastStatus}|null,
       lastCheckAt, nextAttemptAt, suspended, configError}
```

`status` ∈ `disabled|config_error|suspended|online|offline|unknown`. Never `home_token`, prefixes, raw errors, or account claims. `/healthz`/`/readyz` are unchanged.

## 4. Lifecycle / failure states

- Disabled (no env): no timer, no fetch, `status: disabled`. Private conversations/tasks/pairing unaffected.
- Config error (mode/permissions/format/`wrong_home`): no network, `status: config_error`. File is re-stat'ed every tick; fixing/rotating the file recovers without restart.
- Auth `401`/`403`: suspend network until the file changes (`status: suspended`); never busy-retry. Rotation = new file contents + new mtime → resume.
- Transient (network/timeout/`5xx`/`429`/redirect/bad body): `status: offline`, exponential backoff + jitter, NEVER pauses the agent or fails tasks. Cloud-offline home conversation/task flows keep working.
- Rotation while inflight: generation-fenced; a stale inflight result can never publish over newer credential state.
- Stop: abort inflight, bounded drain (≤2s), no orphan fetches.
- Phone F8 rule (out of scope here, recorded so H8/S7 don't guess): a changed cloud `endpointHint` MUST NOT auto-rebind phone device credentials (public UUID is not server proof). A new endpoint requires a fresh local setup invitation. Cloud compromise/recovery therefore cannot capture family device secrets. No new crypto/auth/server-pin policy is invented in this contract.
