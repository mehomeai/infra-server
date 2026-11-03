# Upstream platform adoption audit — OpenBot (CopilotKit) @ 6bfee78

> Implementation update (Nov 2026, Task A infra-server): the phone path
> implemented is NATIVE delivery REST proxied on the home authority
> (`GET /api/agents`, `POST /api/channels/`, delivery conversations/history/
> messages → `202 receiveNative`), NOT raw `POST /api/copilotkit`
> RunAgentInput — §2 step 1 below is superseded. Identity exchange implemented
> as `vendor/openbot/patches/0001-home-identity-bridge.patch` + home proxy
> (`src/upstream-proxy.mjs`); FULL compat tasks REALLY execute upstream
> (`src/upstream-full.mjs`); doctor requires the authenticated SDK entitlement
> read (probe=false never READY). Live contracts:
> `results/platform-wire-contract.json` + `results/platform-client-answers.json`
> (IMPLEMENTED). This audit body is preserved as the phase record.

Scope: Task A only. Owns this doc + `sources/openbot` + `results/platform-contract.json`. No app edits, no commits.
Upstream: `CopilotKit/OpenBot` SHA `6bfee780c8e8d05141375ea55ebde33eefb3dbc0`, MIT, default branch `main`.
Method: public `gh api` + `raw.githubusercontent.com` sparse fetch only (~1.1 MiB, 40 files). No clone, no Docker pull, no `.env` reads.

## 1. What the upstream platform is (code-verified)

Hono API `server/` (port 3001) + Postgres `pgvector/pgvector:pg17` + CopilotKit Intelligence (external) + AG-UI agent endpoints + `agent-computer` (Chromium/files/tools, port 4100) + `supervisor` (Docker socket holder, 4300 container / 4500 host) + `toolkit/` (CopilotKit runtime wiring) + `agent-langgraph-agui/` (AG-UI LangGraph example). Flow verified in `docs/architecture.md` + `server/src/app.ts` + `server/src/copilot.ts` + `server/src/computer/gateway.ts`.

Key reusable whole-platform pieces (run as-is, not copied):

- `server/src/app.ts` — mounts all `/api/*` routes, serves app, wires auth/computers/channels/agents/tasks/memory.
- `server/src/copilot.ts` — `CopilotRuntime` in `mode:"intelligence"`, `mountCopilotKit` at `POST /api/copilotkit`. Built-in bots = `BuiltInAgent`, external = `HttpAgent` over AG-UI. No SSE branch.
- `server/src/computer/gateway.ts` — the only action path: resolve ref from server-held snapshot → `evaluateActionPolicy` (deny-first, absent-deny, fail-closed) → audit row → act. `server/src/computer/policy.ts`, `policy-store.ts`, `client.ts`, `schema.ts`, `snapshot-store.ts`.
- `server/src/computer/routes.ts` — `/:botId/{status,screenshot,read,navigate,snapshot,click,type,key,scroll,control,computers/stop,reset,update,human/*,page-frame/:toolCallId}`, `GET /fleet`, `POST /fleet`.
- `server/src/channels/routes.ts`, `thread-routes.ts`, `thread-identity.ts`, `socket.ts` — channels CRUD, activity, busy/pin/read, thread ids carry `DEPLOYMENT_ID` fingerprint (UUIDv8, 6-byte digest).
- `server/src/agents/endpoint.ts`, `registry.ts`, `agent-resolver.ts` — managed endpoint + token, `AGENT_ENDPOINT_ALLOWED_HOSTS`, handoff caps.
- `toolkit/src/run-turn.ts`, `copilotkit/agents.ts`, `ports.ts`, `lease.ts`, `thread-history.ts` — headless turn runner (mirrors `@copilotkit/runtime` 1.69.0 `runCanonicalChannelAgent`), Intelligence thread lock (`ɵ`-prefixed APIs, Redis-backed).
- `supervisor/src/index.ts`, `docker.ts`, `names.ts`, `environment.ts` — 4 verbs only: `POST /computers/:kind/:id/{ensure,stop,reset}`, `GET /computers`, `GET /health` (open). Auth: `SUPERVISOR_TOKEN` Bearer, else 401. Names derived from `person:<id>` / `bot:<id>`, never raw container names.
- `server/src/work/queue.ts`, `loop.ts` — routines sweep (worker image runs `bun worker/src/index.ts`).
- `server/src/db/schema/{core,identity,tasks,work,computer,memory,...}.ts` + `server/drizzle/0000_schema.sql` … `0074_single_user_identity.sql` — Postgres is the product store; `server/drizzle/*` is the migration chain.
- `agent-langgraph-agui/src/main.py` — `add_langgraph_fastapi_endpoint` via `ag-ui-langgraph`, token header `x-openbot-agent-token`, `BOT_MODEL`/`BOT_PROVIDER`/`OPENAI_BASE_URL`/`CHATGPT_AUTH_FILE` model selection.

## 2. Endpoints / payloads / auth (minimal viable Me→upstream path)

Upstream auth: BetterAuth (Google/Microsoft/Okta) via `server/src/auth/index.ts`; `INITIAL_ADMIN_EMAILS` required; `BETTER_AUTH_URL` + `BETTER_AUTH_SECRET` (≥32 chars) + `TRUSTED_ORIGINS`. `OPENBOT_SINGLE_USER=true` = every visitor is admin `dev-local-user` (`server/src/auth/dev-actor.ts`). UNSAFE for family use — single-user must never ship beyond local dev.

Minimal E2E (Me UI → home private API → upstream execution → persisted result):

1. `POST /api/copilotkit` (Hono handler from `createCopilotHonoHandler`, `server/src/copilot.ts`). AG-UI `RunAgentInput` `{threadId, runId, agentId, messages}`. Auth: upstream session cookie/token for the mapped user. Response: gateway-joined run `{threadId, runId, joinToken, realtime}` then stream; completion/reply only via gateway events (see `toolkit/src/run-turn.ts` notes on `run.mjs:229-247`).
2. Computer actions during the turn go through gateway (`server/src/computer/routes.ts` + `gateway.ts`), not direct to `agent-computer:4100`. Tool calls return to server for auth/audit, then to per-user computer.
3. Supervisor: `POST {COMPUTER_SUPERVISOR_URL}/computers/person/<upstreamUserId>/ensure` with `Authorization: Bearer $SUPERVISOR_TOKEN`, optional JSON `{"carryOver":[botIds≤20]}`. Responses include `{url|port, status, startedAt, carriedOver}`; 409 name-held, 503 + `{starting:true}` = retry. `.../stop`, `.../reset`, `GET /computers` same auth; `GET /health` open.
4. Threads/memory live in Intelligence, not Postgres. `IdentifyUser(request) → {id,name}` (`server/src/copilot.ts`) scopes threads + `grants/connections` to that id. Thread id ownership checked by `createThreadIdentity(DEPLOYMENT_ID).owns(threadId)`.

Me compat facade: keep `POST /v1/pair`, `POST /v1/sessions`, `/v1/conversations`, `/v1/conversations/:id/tasks`, `/v1/tasks/:id` (+cancel/inputs/approvals/artifacts) in `infra-server/src/server.mjs` as a thin facade. Home no longer owns execution/data: `createTaskBroker`/`WorkerStore`/`me_runtime.bridge` become legacy path.

## 3. Auth / owner mapping (family-safe)

- Me `users.id` (SQLite `infra-server/src/db.mjs`, SCHEMA_VERSION 5) → exactly one upstream BetterAuth `users.id` per family member. Never reuse `dev-local-user` across members; never set `OPENBOT_SINGLE_USER=true` on any shared/home deployment.
- Mapping mechanism: server-side exchange only. Me session (`ht1_*`, SHA-256 stored, `infra-server/src/server.mjs:authenticate`) → home looks up `user_id` → mints/asserts upstream identity for that user (BetterAuth sign-in or `OPENBOT_ORGANIZATION_AUTH_URL` employee authority when configured). Client-supplied `user_id`/`workspace`/`model` fields stay rejected (existing `server.mjs` already rejects them).
- Thread/storage ownership: upstream `users` row FK'd by audit table; `ActionActor{ id, userId?, initiator }`. Intelligence threads keyed by upstream user + `deploymentId` fingerprint. Me `owner_id`/`author_user_id` indexes must be migrated 1:1, never coalesced.
- Provider choice: configure ONE real provider (Google or Microsoft-Entra-GUID or Okta) + `INITIAL_ADMIN_EMAILS` + `allowedEmailDomains`. Entra extras: `MICROSOFT_OAUTH_API_SCOPE`, `MICROSOFT_OAUTH_ALLOWED_CLIENTS` (`server/src/auth/entra.ts`, `config.ts`).

## 4. Double-scheduler/store avoidance + retirement map

Upstream owns: durable threads (Intelligence), product rows + audit + policy + grants (Postgres), routine sweep (`server/src/work/*` + worker), computer lifecycle (supervisor). Home must NOT run a second scheduler/store in parallel.

| Me today | Upstream owner | Disposition |
|---|---|---|
| `task-broker.mjs` submit/list/cancel/answer/decide + `TaskWorker` claim/lease/settle | `POST /api/copilotkit` + `toolkit/run-turn.ts` + routines sweep | Retire execution; keep thin `taskView` mapper until UI cutover |
| `vendor/openmuse/.../worker.ts` + `worker-store.mjs` records | Postgres `records`→ upstream tables + Intelligence threads | Retire; one-time owner-scoped export, no dual writes |
| `me_runtime.bridge` (Python `agentic-framework`) + `TASK_RPC_FD` delegation | AG-UI agents (`agent-langgraph-agui`, harness) + handoff caps (`maxDepth 1`, `maxPerRun`) | Retire bridge; delegation becomes Bot-to-Bot handoff |
| SQLite `db.mjs` users/devices/sessions/conversations/messages/artifacts | Postgres + Intelligence | Keep only pairing/session facade rows during migration; conversations/messages become read-through from upstream |
| `runtime-config.mjs` model/caps + `coordinator.mjs` heartbeat + `notifications.mjs` | `BOT_PROVIDER/BOT_MODEL` + Intelligence model routing; worker; Expo push via upstream delivery | Keep `resolveModelConfig` host guard until cutover; coordinator/notifications stay home-side until upstream delivery equivalents wired |

Adapters needed (quantified): (1) Me-session→upstream-user exchange middleware (~1 module); (2) Me task-view ↔ `threadId/runId` mapper (~1 module + `DEPLOYMENT_ID` config); (3) artifacts bridge `GET /v1/tasks/:id/artifacts` → upstream attachments (`/api/attachments`) (~1 route); (4) approvals/inputs `POST .../inputs|approvals` → `HeadlessToolsMiddleware`/`NativeApprovalTool` continuation (~1 module). No new engine code.

## 5. Config / secrets / data placement / images

Required to boot upstream (fail-closed, `server/src/config.ts:loadConfig` + `runtimeCapabilities`): `DATABASE_URL`, `KEY_ENCRYPTION_KEY` (base64 32B; example key refused in production), `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `CPK_INTELLIGENCE_API_KEY` (or legacy `INTELLIGENCE_API_KEY`), plus one auth provider set or `OPENBOT_SINGLE_USER=true` (dev only). Computer: `COMPUTER_SUPERVISOR_URL` + `SUPERVISOR_TOKEN` + `COMPUTER_TOKEN` (or `AGENT_COMPUTER_URL` single-container dev), `COMPUTER_IMAGE` (default `openbot-agent-computer:latest`). Managed bot: `MANAGED_AGENT_AG_UI_URL` + `MANAGED_AGENT_TOKEN` (paired, else no bundled bot).

Data: Postgres volume `postgres-data` (`docker-compose.yml`); computers on `default` net, Postgres on `data` net (audited isolation); Intelligence holds threads/memory. Local Me SQLite stays at current `dbPath` (0600, dir 0700) for facade rows only.

Images / source recipe (pinned to SHA, no digest fetch on this Mac — CI Linux resolves digests): `server` image `openbot-server:latest` built from `server/Dockerfile` (`FROM oven/bun:1.4.3`, `CMD ["bun","src/production-entry.ts"]`); computer from `agent-computer/Dockerfile`; supervisor from `supervisor/Dockerfile`. Reproduce: `gh api repos/CopilotKit/OpenBot/commits/6bfee78` + `docker build -f server/Dockerfile .` at that SHA with `IMAGE_PULL_POLICY=missing` override for installed hosts. `docker-compose.yml` services: `postgres`, `migrate` (`bun scripts/migrate.ts`), `server` (profile `openbot`), `worker`, `agent-computer`, `supervisor`, harness profile.

## 6. Model-free smoke possible today (no licensed Intelligence, no Docker on this Mac)

- `toolkit/tests/{lease,history-sanitize,thread-history,thread-lock,turn-settle}.test.ts`, `agent-computer/tests/{sessions,policy,egress,request-validation,control-store}.test.ts`, `supervisor/tests/{names,health,authorisation,environment}.test.ts` — pure logic, runnable with Bun/Node 24, no model, no gateway.
- `supervisor GET /health` shape + `namesFor` validation — unit-level, no Docker.
- Protocol test: construct AG-UI `RunAgentInput` and validate against `toolkit/src/ports.ts` + `agent-langgraph-agui` `/health` contract without sending to Intelligence.
- What is NOT possible without Intelligence: `server` boot (`loadConfig` throws `CopilotKit Intelligence is required`), any `POST /api/copilotkit` turn, durable thread/memory recall, entitlement-gated features. Do not stub the check; report as blocked.

## 7. Licensing

Code: MIT (`LICENSE`). Runtime dependency: CopilotKit Intelligence is proprietary-managed or self-hosted. `COPILOTKIT_LICENSE_TOKEN` optional on OpenBot side but mandatory on self-hosted Intelligence deployment (Helm `appApi.licenseSecret`), else `RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED` and memory/licensed features refused while conversations continue (`server/src/intelligence-entitlement-check.ts`). Mac local preview license is not a permanent production license. This blocks real E2E until a valid Intelligence project key (managed) or licensed self-hosted Intelligence is provisioned — exact fallback below, no reimplementation of proprietary pieces.

Fallbacks (no proprietary reimplementation, no fake checks): (a) ship facade + protocol/unit smoke now; (b) CI Linux (Docker available) validates full stack after workflow code lands; (c) E2E stays red until Intelligence credential + provider OAuth are supplied as `NEEDS_INPUT`; (d) never claim drop-in or disable `runtimeCapabilities`/policy/entitlement gates.

## 8. Contract handoff

Machine contract: `results/platform-contract.json` (same dir tree as this audit). Selected upstream file paths for implementation: `server/src/app.ts`, `server/src/copilot.ts`, `server/src/config.ts`, `server/src/auth/{index,guards,entra,dev-actor,organization}.ts`, `server/src/computer/{gateway,client,policy,policy-store,routes,supervisor,deployment-routes}.ts`, `server/src/channels/{routes,thread-routes,thread-identity,socket}.ts`, `server/src/agents/{endpoint,registry,agent-resolver}.ts`, `server/src/work/{queue,loop}.ts`, `server/src/db/schema/{core,identity,tasks,work,computer,memory}.ts`, `server/src/{intelligence-client,intelligence-entitlement-check}.ts`, `toolkit/src/{run-turn,ports,lease,copilotkit/agents}.ts`, `supervisor/src/{index,docker,names,environment}.ts`, `shared/intelligence-key.ts`, `agent-langgraph-agui/src/main.py`, `docker-compose.yml`, `server/Dockerfile`, `docs/{architecture,configuration,deployment}.md`.

```json
{"status":"DONE","phase":"platform-audit","upstream":{"repo":"CopilotKit/OpenBot","sha":"6bfee780c8e8d05141375ea55ebde33eefb3dbc0","license":"MIT"},"licensing_gate_blocks_real_e2e":true}
```
