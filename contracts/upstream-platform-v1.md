# upstream-platform-v1 (doctor)

Independent stack doctor: `src/upstream-doctor.mjs` `checkUpstreamPlatform()`.

```json
{ "protocol": "upstream-platform-v1", "state": "READY|NEEDS_INPUT|FAILED",
  "checks": { "mode": "core|full", "probe": true, "sourcePin": {...},
  "config": {...}, "upstreamServer": {...}, "nativeAuth": {...},
  "postgres": {...}, "supervisor": {...}, "perUserBoundary": "...",
  "versions": {...}, "license": {...}, "intelligence": {...}, "model": {...},
  "telemetry": {...}, "datastore": {...} } }
```
Strict schema: `results/setup-doctor-contract.json` (exact REQUIRED evidence
for `READY`; C validators must reject minimal/forged READY).

- `READY`: pin verified (`vendor/openbot/upstream.json` @ pinned SHA, module
  root, never caller cwd) + DEPLOYED checkout (git HEAD == lock revision,
  every file local-sha256 matched, home patch markers + index hook) +
  upstream `/health {status:ok}` + REQUIRED `/api/capabilities` +
  AUTHENTICATED native `GET /api/agents` via signed probe (patch + DB +
  per-person provider) + Postgres TCP liveness + supervisor
  `/health {status:ok,docker:true}` + token list accepted + config/license
  gate passed + Intelligence entitlement ACTIVE via the authenticated
  official SDK read (`getRuntimeEntitlements`, SDK pinned 1.83.0) +
  SELECTED model served (exact tag: Ollama tags / live OpenAI-Anthropic
  `/v1/models`, redirects refused, bounded) + telemetry enforced off +
  storage perms (no world-writable) + no upstream `EXPO_PROJECT_ID`.
- `NEEDS_INPUT`: missing operator input (tokens, OAuth, Intelligence
  key/license/model, OPENBOT_CHECKOUT, SDK package/version, unreachable
  services). Anthropic included via read-only `/v1/models` (completable).
  `probe=false` (e.g. `--no-probe`) NEVER yields `READY`.
- `FAILED`: drift (deployed/source), unsafe `OPENBOT_SINGLE_USER`,
  short/example bridge secret, privacy violation (managed Intelligence
  without opt-in, upstream push enabled, telemetry on), bad/rejected keys
  (401/403), expired/misconfigured Intelligence licence, unpatched
  upstream (native probe 401), docker:false supervisor, world-writable
  storage, health-proxy-only stacks.

An anonymous health fetch never satisfies the Intelligence or native-auth
checks — only the authenticated SDK read and the signed probe do. C
supervisor may call this contract; C files are not changed here. Home
coordinator/notification boundaries preserved (separate private user auth).
Home server capability splits honest state: `configValid` (offline env)
vs `fullConfigured` (configValid + fresh bounded live doctor evidence).
