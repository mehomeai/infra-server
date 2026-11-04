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

## Readiness handshake (OPEN #4)

The home server's live tracker (`src/upstream-live.mjs`) re-evaluates this
contract's probe evidence continuously, in two tiers over the shared probe
set (`src/upstream-probes.mjs`, the same native-auth/fleet/model blocks the
doctor runs; the doctor keeps verdict ownership):

- **Light tier** every 120 s (singleflight): upstream `/health`,
  `/api/capabilities` projection, signed user-role `GET /api/agents`.
  Evidence TTL 300 s.
- **Full tier** every 600 s (singleflight, never concurrent with light):
  health + capabilities + fleet admin probe (`GET /api/computers/fleet`
  admin ⇒ `{isolation, computers[]}` with per-person keys) + user-role
  fleet denial (403/401; any success is an isolation failure) + model
  served. Evidence TTL 900 s. Fresh passing evidence from BOTH tiers is
  required before readiness is published; light alone never publishes,
  and any failure drops readiness immediately (no last-known-good grace
  for fleet/model failures).
- **Container-namespace Ollama proof** (local route): the full tier asks
  the harness itself for its served-model view (`ME_HARNESS_MODEL_URL`,
  default `<harness base>/models`), falling back to a supervisor witness
  route (`ME_SUPERVISOR_PROBE_URL`), and only then to the host-side
  `/api/tags` read. Evidence records `checks.model.namespace` =
  `harness|supervisor|host`; readiness requires `harness` (or
  `supervisor` during a documented transition) — `host` alone is never
  READY. Remote provider routes keep the doctor's provider-list proof.
- **Invalidation**: a generation counter discards any in-flight probe
  result invalidated mid-flight. Triggers: per-tier TTL expiry, any probe
  failure, an external doctor-cache write (a CLI doctor verdict supersedes
  tracker evidence in both directions), and a config fingerprint change
  (sorted REQUIRED_ENV values + `BOT_MODEL`/`OPENAI_BASE_URL`).
- **Cache**: `doctor-cache.json` keeps its payload contract
  (`protocol/state/mode/pin/at/ttlMs`); tracker writes add only `tier` +
  `generation`, which existing readers ignore.
- **Intelligence entitlement** is not re-probed by the tracker (it needs
  the pinned SDK); the doctor CLI/cache remains its authority and the
  tracker's full checks report `intelligence: {probed:false,
  source:'doctor'}`.
