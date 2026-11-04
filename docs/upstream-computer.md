# Upstream computer plane (CORE, licence-free)

Upstream: `CopilotKit/OpenBot` `@ 6bfee780c8e8d05141375ea55ebde33eefb3dbc0` (MIT).
Lock: `vendor/openbot/upstream.json`. Verifier: `scripts/upstream-openbot.py`.

Deployment executes ACTUAL upstream `agent-computer` + `supervisor`
Dockerfiles/services from a pinned checkout (`scripts/openbot-checkout.sh`,
`deploy/upstream-core.yml`). No in-repo copy of huge assets, no rewritten
engine called OpenBot. Me home keeps auth/pairing + OpenMuse task worker;
upstream owns browser/computer execution.

Machine handoff for Task B (runtime client): see
`/private/tmp/me-upstream-migration-20261103/results/computer-contract.json`
(this doc is the human companion; the JSON is authoritative for B).

## Supervisor (4 verbs, Bearer token)

Base: `COMPUTER_SUPERVISOR_URL` (`http://supervisor:4300` in compose,
`http://127.0.0.1:4500` on host). Auth: `Authorization: Bearer
<SUPERVISOR_TOKEN>` exactly (`supervisor/src/authorisation.ts`
timingSafeEqual). Open without auth: `GET /health` → `{status:"ok",
docker:bool}`.

- `POST /computers/person/<upstreamUserId>/ensure` [body optional
  `{"carryOver":[botIds≤20]}`] → `{kind,id,container,status,port?,url?,
  startedAt?,health?,carriedOver?,spiffeId?}`; `503 {starting:true}` = retry;
  `409` = derived name held by non-owned container; `400` = bad id.
- `POST /computers/bot/<botId>/ensure` (carryOver forbidden).
- `POST /computers/person|bot/<id>/stop` → `{stopped}` (keeps logins).
- `POST /computers/person|bot/<id>/reset` → `{reset}` (deletes profile).
- `GET /computers` → `{computers:[...]}` (same auth).

IDs: `^[A-Za-z0-9][A-Za-z0-9_-]*$`, ≤64 (`supervisor/src/names.ts`). Derived
container `{ns}-computer-{kind}-{id}`, volumes `{ns}-profile-{kind}-{id}` and
`{ns}-workspace-{kind}-{id}` with ownership labels. Caller never sends
container names. Namespace: `COMPUTER_NAMESPACE` (default `openbot`).

## Computer transport (internal, NOT the runtime path)

Located URL or `AGENT_COMPUTER_URL` (single-container dev). Headers:
`x-openbot-computer-token: <COMPUTER_TOKEN>` (exact, required, only
`GET /health` open without it) + `x-openbot-bot-id` + `x-openbot-person-id`
(`server/src/computer/client.ts`, `provider.ts`). Timeout 45s, exec ≤600s.

Runtime client MUST go via the server gateway below, never direct: policy,
audit, and identity live there.

## Server gateway (the runtime path)

Mounted at `/api/computers` (`server/src/app.ts`) behind the upstream session
+ bot-access check. Full route table, payloads, and error mapping are in the
machine contract. Summary of the shapes B needs:

- Browser: `GET :botId/status`, `GET :botId/screenshot`, `GET :botId/read`,
  `POST :botId/navigate {url,toolCallId?}`,
  `POST :botId/snapshot` → `{snapshotId:int, elements:[{ref,...}]}`,
  `POST :botId/click|type|key|scroll {ref,snapshotId,...}`.
- Files/workspace: `POST :botId/files/list|read|write`, `GET
  :botId/files/download?path=`, `POST :botId/exec {command,timeoutMs 1k..600k}`.
- Control/secret: `GET|POST :botId/control*` (`request|take|release|cancel`),
  `POST :botId/control/secret {ref,snapshotId,label?}` (bot asks),
  `POST :botId/human/secret {text}` (ONLY secret ingress, never logged),
  `POST :botId/human/:kind`.
- Admin: `GET|POST /fleet`, `GET /:botId/computers`, `GET|PUT /policy`,
  `POST /policy-dry-run`.

Snapshot semantics: `snapshotId` integer generation; refs resolve only against
the same `snapshotId` + same computer run generation (`sessionOf`); else `409
{stale:true}` (re-snapshot), `{humanHasControl:true}` (leave to holder),
`{needsConversation:true}` (resend via approval route),
`{starting:true,notPerformed:true}` (cold start, retry). Audit records counts,
never secret values. Thread ids carry `DEPLOYMENT_ID` fingerprint.

## Auth / owner mapping (family-safe)

Me `ht1_*` session (validated home-side) → 1:1 upstream BetterAuth user via
SERVER-SIDE exchange only (NOT an existing upstream feature; must be built,
never faked). Never trust client `user_id`/`workspace`/`model`. Never
`OPENBOT_SINGLE_USER=true` on shared/home. Client helpers:
`src/upstream-computer.mjs` (`defaultUpstreamPersonId`,
`supervisorPathFor`, `seatHeaders`, `createSupervisorClient`).

CORE scope: ONLY the home-validated owner selects their private computer; home
holds both tokens server-side (0600/0700); per-computer credential never
reaches LLM/phone; no runtime public-actor override; missing upstream →
`NEEDS_SETUP`/unavailable, never silent fallback.

## Telemetry opt-out

`DO_NOT_TRACK=1` or `COPILOTKIT_TELEMETRY_DISABLED=1` always overrides
`OPENBOT_PRODUCT_TELEMETRY=1`; `0` disables. Home never enables upstream
telemetry by default.

## CopilotKit RPC warning (do NOT invent)

`POST /api/copilotkit` is a CopilotKit Hono handler (gateway-JOIN, not a raw
AG-UI endpoint). Do NOT POST raw `RunAgentInput` from runtime; CORE computer
use needs no CopilotKit facade. Any future facade must audit
`@copilotkit/runtime` 1.69.0 shapes first.
