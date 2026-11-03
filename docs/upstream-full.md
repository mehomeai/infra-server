# FULL primary (licensed self-hosted Intelligence)

User decision (results/license-decision.json): FULL OpenBot platform is
PRIMARY. All conversations/memory stay on HOME-OWNED self-hosted
Intelligence; no managed cloud default. No key supplied; code + independent
tests proceed, licensed validation reports NEEDS_INPUT honestly.

## What FULL reuses (actual upstream, not rebranded Me engine)

- Upstream server + Postgres (`pgvector/pg17`) + `migrate` + `worker`
  (routines sweep via `work/queue.ts` DB-clock leases) + `supervisor` +
  `agent-computer` + managed native harness (B packages the harness
  container; A references the launcher-built `${HARNESS_IMAGE}` + paired
  `MANAGED_AGENT_TOKEN`). Standalone runnable stack:
  `deploy/upstream-full.yml` (builds from `OPENBOT_CHECKOUT`); Intelligence
  is the OFFICIAL Helm chart (`oci://ghcr.io/copilotkit/charts/intelligence`,
  overlay `deploy/upstream-intelligence-values.yaml`). Installer:
  `scripts/upstream-full-install.sh`.
- Phone transport is native delivery REST (the audited mobile path), proxied
  on the same home authority after `ht1_*` validation + signed assertion
  (`src/upstream-proxy.mjs`, mounted in `src/server.mjs`): `GET /api/agents`,
  `POST /api/channels/`, `GET /api/delivery/conversations`,
  `GET .../history?agentId=`, `POST .../messages {agentId,text,externalId:UUID}`
  → `202 receiveNative`, plus `/api/tasks`, `/api/approvals`,
  `/api/computers`, `/api/attachments`, `/api/proactive`, `/api/routines`,
  `/api/memory`. `/api/copilotkit` stays mounted for the upstream-internal
  native pipeline only (gateway-JOIN, NOT raw AG-UI, not the phone path).
- Tool callback: `POST /api/agent-tools/call` (`x-openbot-agent-token` +
  signed run assertion, `authoriseAgentCall`).
- Threads/memory: Intelligence-owned; UUIDv8 + 6-byte `DEPLOYMENT_ID`
  fingerprint (`thread-identity.ts`); home keeps no second thread store.
- Computer: always the server gateway `/api/computers` (policy snapshots,
  audit); never direct `agent-computer:4100` in FULL.
- Tasks/queue/handoff: upstream native (`tasks/routes.ts`,
  `work/queue.ts`, toolkit turn/lease). Home compat in FULL REALLY executes:
  `POST /v1/conversations/:id/tasks` requires explicit `agentId` and runs
  `POST /api/channels/` + `POST .../messages` (`src/upstream-full.mjs`
  `submitToUpstream`, no local runner, no second scheduler); GET list/get
  bridge to the authoritative roster/channel read. Legacy SQLite rows stay
  readable explicitly (`execution: legacy-home`); missing upstream →
  NEEDS_SETUP, never silent fallback.

## Identity hook (implemented patch, not a doc claim)

Upstream has no `ht1→BetterAuth` exchange. Applied seam:
`vendor/openbot/patches/0001-home-identity-bridge.patch` adds
`server/src/home-bridge.ts` (HMAC assertion verifier) + one hunk in
`server/src/index.ts` wrapping the assembled `AuthService` BEFORE
`createApp`/`createRequestActor`, covering every guard, the Copilot
identify seam and the WS stream guard. Deterministic `apply.sh`
(idempotent), ledger in `vendor/openbot/patches/README.md`, checkout
applies it (`scripts/openbot-checkout.sh`), deployment verified
(`upstream-openbot.py verify --deployed`). Home side:

- `identifyUpstreamUserForSession` / `identifyUpstreamActorForSession`
  (`src/upstream-identity.mjs`): validate Me session first, 1:1 map via
  `upstream_users` (UNIQUE both sides), role from `ME_UPSTREAM_ADMIN_USERS`
  locally. No shared `dev-local-user`, no `OPENBOT_SINGLE_USER` on shared/home,
  no body `user_id` trust. Upstream `BetterAuth` + guards + roles intact.
- Per-request single-use signing in `src/upstream-proxy.mjs`
  (`v2.{id}.{exp}.{role}.{nonce}.{mac}`, 128-bit nonce, 60s TTL,
  `ME_HOME_BRIDGE_SECRET` ≥32 chars, phone credentials stripped, never
  forwarded). Bridge-only deployments need no separate OAuth app.
  Real-boundary proof: `test/upstream-native-proxy.test.mjs`
  (two-family isolation, spoofed-assertion overwrite, cross-owner 404/400)
  + `test/upstream-patch-live.test.mjs` (real patched module: replay
  refusal, per-request role refresh, bridge-only mode).

## Operator env (0600 file, never in chat/logs/repo)

```
ME_UPSTREAM_MODE=full
ME_DATA_DIR=$HOME/me-data                # operator-owned data dir (0700)
ME_UPSTREAM_ENV_FILE=$ME_DATA_DIR/upstream-full.env
OPENBOT_CHECKOUT=$HOME/openbot          # pinned SHA + applied patch (installer --full to build)
UPSTREAM_SERVER_URL=http://127.0.0.1:3001   # private loopback/compose listener only
DATABASE_URL=postgres://openbot:<pw>@postgres:5432/openbot
KEY_ENCRYPTION_KEY=<base64-32B, not the example>
ME_HOME_BRIDGE_SECRET=<>=32 chars, dedicated bridge secret, never shared>
INTELLIGENCE_API_URL=https://intelligence.home.example
INTELLIGENCE_GATEWAY_WS_URL=wss://intelligence.home.example
CPK_INTELLIGENCE_API_KEY=<project key>
COPILOTKIT_LICENSE_TOKEN=<self-hosted license, on Intelligence deploy too>
BETTER_AUTH_URL=http://127.0.0.1:3001 BETTER_AUTH_SECRET=<>=32 chars>
INITIAL_ADMIN_EMAILS=<owner> TRUSTED_ORIGINS=http://127.0.0.1:3010
ME_UPSTREAM_ADMIN_USERS=<owner me id/email>
COMPUTER_SUPERVISOR_URL SUPERVISOR_TOKEN COMPUTER_TOKEN (computer plane)
HARNESS_IMAGE=<built from B canonical context> HARNESS_CONTEXT_DIR or HARNESS_PREBUILT_IMAGE + MANAGED_AGENT_TOKEN (native harness POST / on 4206; OPENBOT_TOOL_URL is the full callback URL)
ME_KUBE_CONTEXT + ME_KUBE_API_URL + ME_KUBE_NAMESPACE (explicit home cluster; guard refuses wrong-cluster deploys)
INTELLIGENCE_CHART_VERSION=<pinned official chart, deploy/intelligence-chart.lock> INTEL_VALUES=<operator secrets overlay>
BOT_PROVIDER=openai BOT_MODEL=gpt-5.5 (single native source shared by harness, tenant model.yaml, doctor; local Ollama route = openai + OPENAI_BASE_URL=http://127.0.0.1:11434; remote needs OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY; provider:model prefix allowed; unknown provider fails closed)
```

Tenant: `deploy/tenant-package/me` (personal Me agent on the native harness,
read-only mount, `TENANT_PACKAGE_DIR=/tenant/me`; installer refuses a missing
package). Never the upstream fintech sample: the five required native files
are schema-tested (`test/upstream-tenant.test.mjs`, no Bun/Docker needed).
`DEPLOYMENT_ID` is generated once and persisted by the installer (unique home
installation namespace).

Doctor: `node --experimental-transform-types src/cli.mjs upstream-doctor`
(`upstream-platform-v1`; `--no-probe` never yields READY). FULL READY only
when pin + deployed checkout (git HEAD == lock, unexpected tracked drift
refused) + applied patch + server `/health{ok}` + REQUIRED `/api/capabilities`
+ AUTHENTICATED native `GET /api/agents` + fleet probes + Postgres TCP liveness +
supervisor auth/list (docker:true) + computer + AUTHENTICATED Intelligence entitlement
(official SDK `getRuntimeEntitlements`, active licence, pinned 1.83.0) + SELECTED
native model served (exact tag; BOT_PROVIDER/BOT_MODEL, same as the harness) +
telemetry enforced off + storage perms + no upstream push. Missing credentials/SDK/
checkout/model → honest NEEDS_INPUT (Anthropic included via read-only /v1/models);
bad key/expired licence/drift/unsafe config → FAILED.
Standalone core stays explicit dev/partial (`deploy/upstream-core.yml`); FULL
is primary (`deploy/upstream-full.yml` + installer).
