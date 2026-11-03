# H8 integration handoff — actual home ↔ hosted-backend coordination

Companion to `contracts/home-coordination-v1.md` (authoritative for the home
file + loop) and `contracts/home-api-v1.md` (private API, unchanged).
Backend wire is owned by `backend-server/docs/home-activation-v1.md` (B7) +
`docs/backend-api-v1.md` (B4); do not re-implement it here.

## What H8 delivers (infra-server only)

- `src/coordinator.mjs`: private-file loader/validator + periodic HomeToken
  heartbeat loop. Disabled by default (zero network unless
  `HOME_COORDINATOR_CREDENTIALS_FILE` is set). Initial heartbeat is async +
  nonblocking; period default 60s with backoff/jitter (max 5 min); per-attempt
  timeout + bounded `64 KiB` body; `redirect: 'error'` with final-origin
  checks; `401`/`403` suspends until the file changes; transient failures stay
  `offline`-rescheduled and never pause the agent; generation-fenced rotations;
  abort + bounded drain on stop (no orphans).
- Wired into `createHomeServer`: `coordinator.start()` on home start,
  `coordinator.stop()` on shutdown, redacted `GET /v1/coordinator/status`
  (session-authenticated; never token/prefix/raw errors/account claims).
  `/healthz`/`/readyz` unchanged. Private conversations/tasks/pairing work
  identically with the coordinator disabled, misconfigured, suspended, or
  cloud-offline.
- `buildRuntimeEnv` exclusion extended with `HOME_COORDINATOR_*`: the
  credentials-file reference and any cloud/home token material never enter
  runtime bridge children. Sentinel tests assert no `me_home_*`,
  `HOME_COORDINATOR_*`, Expo push, `SSH_*`, or `AWS_*` in child env beyond the
  single trusted model key.

## For setup (S7: writes the file)

1. Phone (owner account) mints an activation ticket:
   `POST /v1/homes/activation-tickets {installationId, displayName? |
   existingHomeId?}` (account auth). Copy the one-time JSON
   `{backend_url, ticketId, activationSecret, installationId, mode, homeId?,
   expiresAt}` to the home operator (never an account JWT or provider secret).
2. Home redeems ticket-only (NO `Authorization` header):
   `POST {backend_url}/v1/homes/activate
   {ticketId, activationSecret, installationId (exact own), endpointHint,
   protocolVersion}`. `endpointHint` MUST be public `https://`, or
   `http://` loopback only for explicit dev/test. Backend never fetches it.
3. On `201 {homeId, installationId, homeToken, endpointHint,
   protocolVersion, mode}`, write the private file EXACTLY:

```json
{
  "protocol": "home-coordinator-v1",
  "backend_url": "https://backend.example.test",
  "home_id": "home_…",
  "installation_id": "123e4567-…",
  "home_token": "me_home_…",
  "endpoint_hint": "https://home.example.test"
}
```

plus `"protocol_version": "home-api-v1"`. Absolute path outside git/shared
config, `0600`, regular file, `≤16 KiB`, no final symlink. Never log the
secret or ship it to the phone.

4. Set `HOME_COORDINATOR_CREDENTIALS_FILE=<absolute file>` (+
   `HOME_COORDINATOR_ALLOW_HTTP_LOOPBACK=1` ONLY for loopback dev/test) and
   (re)start the home. `installation_id` MUST match `GET /healthz`.
5. Unknown activate outcome (timeout/disconnect): do NOT retry the same
   ticket. Discover via `GET /v1/homes` (owner account), mint a FRESH recovery
   ticket with `existingHomeId`, redeem once, persist the fresh `homeToken`.
6. Full restore / file deleted: reactivation needed (fresh ticket, same flow).
   Old tickets correctly replay `410`.

## For the consumers

- `phone-app`: keep using the direct protected home URL from the local setup
  invitation. Treat backend `endpointHint` as a discovery hint only; NEVER
  auto-rebind device credentials from a changed hint (F8) — a new URL requires
  a fresh local invitation. No fake heartbeat is needed from the phone; the
  home heartbeats itself.
- `backend-server/setup-infra`: preserve the SQLite file + tasks root as
  before; preserve the coordinator file across upgrades (or reactivate). No
  provider cloud resources, no new framework/deps (built-in fetch only).
- `agentic-framework`: no changes. Coordinator secrets never enter
  `buildRuntimeEnv`; `ME_RUNTIME_*` filtering (H7.1) is unchanged.

## What H8 does not claim

- Single-host SQLite, loopback-default bind, no quotas/backups beyond H2/H5.
- No brokered private chat storage/relay, no SSH, no provider-secret handling.
- No app-layer crypto, no second server trust system, no server pin policy.
- No cloud-driven private-URL/model/auth reconfiguration: heartbeat responses
  are liveness observations only.
