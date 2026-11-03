# End-to-end runbook — Me home service (infra-server)

How to install, configure, pair, run, and verify the household home service
across the sibling repositories. Authoritative API contract:
`contracts/home-api-v1.md` (+ `.openapi.json`). This runbook coordinates
commands and manual gates; it does not duplicate the contract.

Conventions: `<me>` is the directory holding the sibling checkouts
(`infra-server`, `agentic-framework`, `backend-server`, `phone-app`,
`setup-infra`, …). All home commands run from `<me>/infra-server` unless noted.
Do not run home commands from another repository.

## 0. Prerequisites (local-first)

- Node.js 24.18.x: `node --version` must print `v24.18.x`. Any install method
  works; one option is nvm (`nvm install 24.18.0`).
- Python 3 for repository hygiene scripts (`python3 --version`).
- The home service needs Node's type-stripping for the vendored worker import,
  so **every** home entrypoint carries the flag (already baked into
  `package.json` scripts):
  `node --experimental-transform-types …`
- No `npm install` is required inside `infra-server` (stdlib only, no
  dependencies).
- Agent runtime: prefer the managed setup docs first
  (`setup-infra/docs/home-coordination-activation.md`). Manual low-level
  alternative (from `<me>/agentic-framework`, per its README — editable
  install required because the `src/` layout will not import otherwise):
  ```sh
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  .venv/bin/pip install --no-deps -e .
  ```
  Then point the home at that venv python (see `src/runtime-config.mjs`:
  `ME_RUNTIME_ARGV` JSON array wins, `ME_RUNTIME_CWD` sets the child cwd;
  default without env is `python3 -m me_runtime.bridge`):
  ```sh
  export ME_RUNTIME_ARGV='["<me>/agentic-framework/.venv/bin/python","-m","me_runtime.bridge"]'
  export ME_RUNTIME_CWD="<me>/agentic-framework"
  ```
  The home never installs or modifies the runtime; it only spawns the
  configured command. Pinned `langgraph==1.2.19` / `prebuilt==1.1.1`.
- Local-first model default requires Ollama on the home host
  (`http://127.0.0.1:11434`); without it, task runs honestly report
  `model_not_configured` until a model is configured (see §2).

## 1. Start the home service

```sh
node --version            # v24.18.x required
npm run start:home -- --db=data/home.sqlite --host=127.0.0.1 --port=7070
# or explicitly:
node --experimental-transform-types src/cli.mjs start --db=data/home.sqlite
curl http://127.0.0.1:7070/healthz
# {"status":"ok","installation_id":"<uuid>","contract":"home-api-v1"}
```

The service binds loopback by default. Binding anything else prints a warning
and is only for the operator-provisioned protected named-tunnel endpoint
(`setup-infra` records the reference; it never provisions accounts/DNS).
Data lives in the SQLite file plus `<dbdir>/tasks` workspaces; keep both
with 0700/0600 permissions (enforced on open). Start loopback once (or
bootstrap the initial DB) so SQLite mints the REAL authoritative
`installation_id` — the fresh-setup reserved config UUID is NOT usable, and
`coordinator prepare`/`activate` require the real DB id. Backend account
ticket flow is optional for an already-paired private install; see
`setup-infra/docs/home-coordination-activation.md` (S7) for prepare →
STDIN-only activate → restart, and `backend-server/docs/home-activation-v1.md`
(B7) for the wire.

Model/runtime configuration (all host env, never from clients). CHOOSE ONE
model block; do not stack them (later exports overwrite earlier ones):

```sh
# Option A — production default: local-first (needs Ollama).
# No fixture fallback; remote keys are ignored here.
export HOME_MODEL_PROVIDER=local
```

```sh
# Option B — synthetic fixture demo ONLY (offline lifecycle path, §2).
export HOME_MODEL_PROVIDER=fixture HOME_ALLOW_FIXTURE_MODEL=1
export ME_RUNTIME_ARGV='["node","test/fixture-bridge.mjs"]'
```

```sh
# Option C — explicit remote opt-in ONLY (example: Meta via OpenAI-compatible
# Responses API). Prompts/tool context leave home under this option.
export HOME_MODEL_PROVIDER=openai HOME_MODEL_NAME="<meta-model>"
export ME_RUNTIME_ALLOW_REMOTE=1 ME_RUNTIME_MODEL_API_KEY="<secret>"
export HOME_MODEL_USE_RESPONSES_API=1
# Optional compatible endpoint (placeholder, no actual key):
export HOME_MODEL_ENDPOINT="https://<compat-host>/v1"
```

```sh
# Optional for any option: runtime command with spaces in paths + tuning:
export ME_RUNTIME_ARGV='["/path/with spaces/python","-m","me_runtime.bridge"]'
export HOME_RUNTIME_TERM_GRACE_MS=3000 HOME_RUNTIME_KILL_GRACE_MS=3000
export HOME_RUNTIME_WALL_ALLOWANCE_MS=30000 HOME_SHUTDOWN_MS=15000
export HOME_AUTH_RATE_MAX=20 HOME_AUTH_RATE_WINDOW_MS=60000
# HOME_TRUST_PROXY=1 trusts X-Forwarded-For only from a loopback peer
# (local tunnel/edge connector); default 0 trusts the direct peer only.
```

## 2. Synthetic fixture demo (clearly marked — not a real agent run)

Everything in this section uses the **explicitly labeled offline fixture**
(`provider:fixture` + `test/fixture-bridge.mjs`). It proves the home
subprocess/task lifecycle path only. It proves nothing about model quality,
live providers, browsers, or renderers.

```sh
export HOME_MODEL_PROVIDER=fixture HOME_ALLOW_FIXTURE_MODEL=1
export ME_RUNTIME_ARGV='["node","test/fixture-bridge.mjs"]'
node --experimental-transform-types src/cli.mjs seed-dev --db=/tmp/demo.sqlite
node --experimental-transform-types src/cli.mjs bootstrap --user=alice --db=/tmp/demo.sqlite
# -> {"installation_id":"...","user_id":"alice","invitation_id":"inv_...","invitation_secret":"...","expires_at":...}
```

## 3. Pair a phone (first owner, then additional devices)

Primary path — trusted local `home-pairing-v1` invitation (setup-owned).
Local bootstrap authorizes the first invitation (filesystem access is the
authorization). An authorized session (or a second local bootstrap) creates
further invitations. Invitations are one-time capabilities (no SSH, no
account JWT); the account activation ticket (§1/S7) is a separate flow.

```sh
# From <me>/setup-infra (exact flags: me_lifecycle.py bootstrap --help):
python3 scripts/me_lifecycle.py bootstrap --data-dir data/home \
  --user alice --format pairing-v1 [--public-url https://home.example.com]
# [--allow-http-loopback for http:// loopback dev only]
# -> home-pairing-v1 JSON on stdout only:
# { protocol, home_url, installation_id, invitation_id, invitation_secret,
#   user_id, expires_at? }
```

Deliver that JSON out-of-band to the phone; the phone pastes it into the
pairing screen (see `setup-infra/docs/home-coordination-activation.md` §7
and `phone-app/docs/client-adapter.md`). The `home_url` comes from local
config (`--public-url` / `ME_HOME_PUBLIC_URL` / coordinator `public_home_url`
/ tunnel hostname) — never from a backend `endpointHint`. Redact the secret
from tickets/logs.

Optional raw H1 API (backward-compatible, same effect — no QR generation
feature is claimed):

```sh
INV=$(node --experimental-transform-types src/cli.mjs bootstrap --user=alice --db=data/home.sqlite)
# Pair (single-use, 15 min default, bound to alice and this home):
curl -X POST http://127.0.0.1:7070/v1/pair -H 'content-type: application/json' \
  -d '{"invitation_id":"inv_...","invitation_secret":"...","device_label":"alice phone"}'
# -> {"device_id":"dev_...","device_secret":"<show once>","user_id":"alice","installation_id":"..."}
# Mint a short-lived session token (12 h, revocable via the device):
curl -X POST http://127.0.0.1:7070/v1/sessions -H 'content-type: application/json' \
  -d '{"device_id":"dev_...","device_secret":"..."}'
# -> {"token":"ht1_...","expires_at":...}
# All further calls: Authorization: Bearer ht1_...
```

Manual gate: pairing must be started locally or from an authorized admin
session; an account token alone never claims a home. Re-pairing a wiped phone
needs a fresh invitation. Two phones racing one invitation enroll at most one
(loser: `410 invitation_consumed`).

## 4. Conversations, tasks, questions, approvals (curl lifecycle)

```sh
T=ht1_...  # session token from §3
CID=$(curl -s -X POST http://127.0.0.1:7070/v1/conversations -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"title":"Trip"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
# Idempotent message (retry-safe with request_key UUID):
curl -X POST http://127.0.0.1:7070/v1/conversations/$CID/messages -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"body":"hello home","request_key":"123e4567-e89b-42d3-a456-426614174000"}'
# Submit a task (capabilities narrow-only; model is home-selected):
TID=$(curl -s -X POST http://127.0.0.1:7070/v1/conversations/$CID/tasks -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"request":"summarise this","title":"Notes"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl -s http://127.0.0.1:7070/v1/tasks/$TID -H "Authorization: Bearer $T" | python3 -m json.tool
# Question lifecycle (example task request containing "ASK:..."):
curl -X POST http://127.0.0.1:7070/v1/tasks/$TID/inputs -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"inputs":[{"id":"q1","answer":"MP4"}]}'
# Approval lifecycle (IDs are per-task: "<taskId>:<runtimeId>"):
curl -X POST http://127.0.0.1:7070/v1/tasks/$TID/approvals -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"approvals":[{"id":"'"$TID"':a1","decision":"approve"}]}'
# Completed output lands in the conversation as the assistant message; fetch bytes:
curl -s http://127.0.0.1:7070/v1/tasks/$TID/artifacts -H "Authorization: Bearer $T"
curl -OJ http://127.0.0.1:7070/v1/tasks/$TID/artifacts/<artifactId> -H "Authorization: Bearer $T"
```

Manual gates: answers/approvals are explicit user decisions per inbox item;
approvals never widen capabilities; rejecting fails the run honestly
(`approval_rejected`); progress is visible while the run executes.

## 5. Revocation, restart, backup (setup owns the tool; home owns the data)

- Revoke a device: `POST /v1/devices/:id/revoke` — sessions die immediately,
  renewal is refused. A revoked phone keeps no access even with a cached token.
- Failed pair/session attempts are rate limited per IP (429 + `Retry-After`).
- Restart the service (Ctrl-C / SIGTERM, then `npm run start:home` again):
  shutdown is bounded (SIGTERM, escalate to SIGKILL, capped waits — a child
  that ignores SIGTERM cannot wedge it); in-flight runs are marked failed
  ("not retried"), waiting tasks resume via §4, chats/installation survive
  (SQLite). Verify with `GET /healthz` (same `installation_id`).
- Backup: use setup `me_lifecycle.py backup/restore` (see
  `setup-infra/docs/home-coordination-activation.md`). `--scope db` (default,
  online-safe) covers the SQLite database only. `--scope full` (stopped
  service only) archives SQLite + per-task workspaces (incl. `.me_runtime`
  checkpoints) + household files + manifest — config/logs/secrets excluded,
  local-only, never uploaded. Full restore validates before mutating, swaps
  under a durable write-ahead journal with rollback (NOT one atomic
  transaction), and revokes restored sessions/devices/invitations (pair fresh
  afterwards). The coordinator `0600` 7-key file and operator env are NOT in
  the archive — reactivation needs a fresh ticket; workspace MAY hold private
  cookies/keys so backups are never claimed secret-free. Backups contain
  household data — encrypt at rest. Schema versions are gated; never
  downgrade a database.

## 6. Cross-repo verification table (local finals; run each suite from its own repo)

Overall report: `backend-server/docs/final-validation.md`. Implemented
locally — not shipped; all changes uncommitted; remote GitHub CI did not run.

Local evidence root (ephemeral, not committed): `/private/tmp/me-opencode-live-20261103` — proof logs under `logs/`, release marker `source-release-ready.json`.

| Repo | Command (from repo root) | Final result |
| --- | --- | --- |
| backend-server | from `backend-server`: `npm test` (= `node --test test/*.test.mjs`) | 39 pass / 0 fail (`logs/accepted-backend-latest.log`) |
| infra-server (this repo) | from `infra-server`: `npm run test:home` (= `node --experimental-transform-types --disable-warning=ExperimentalWarning --test test/*.test.mjs`) | 103 pass / 1 skip / 0 fail — single intentional runtime-presence gate marker; actual bridge cases ran (`logs/accepted-home-latest.log`) |
| infra-server + agentic-framework | from `<me>/agentic-framework`: `ME_RUNTIME_REQUIRE_HOME=1 node --experimental-transform-types --disable-warning=ExperimentalWarning --test --test-concurrency=1 tests/run_home_*.mjs` (Node 24; test-file concurrency 1 since each boots real runtime children; within-case child concurrency preserved) | 9 pass / 0 fail, 101.6s (`logs/accepted-home-runners-serial-release.log`; one overloaded concurrent run showed 2 polling-timeouts that passed on focused rerun, no source changes) |
| agentic-framework | from `<me>/agentic-framework` venv: `.venv/bin/python -m pytest tests -v` (optional live/provider/browser smoke gates skipped) | 122 pass / 4 skip / 0 fail, 273.29s (`logs/runtime-final-context-review.jsonl`) |
| agentic-framework | from `<me>/agentic-framework` venv: targeted context+response subset via `.venv/bin/python -m pytest` on the files listed in the log header (subset of full) | 29 pass / 0 fail (`logs/accepted-runtime-context-release.log`) |
| setup-infra | from `setup-infra`: `python3 -m unittest discover -s scripts -p 'test_*.py' -v` | 99 pass / 0 fail, 229.8s — ALL setup/lifecycle/full-backup/crash-window/coordinator (`logs/accepted-setup-release.log`) |
| phone-app | from `phone-app`: `npm test` (portable unit, no native mount) | 86 pass / 0 fail (`logs/phone-activation-review.jsonl` + root exec observed 86) |
| phone-app | from `phone-app`: `npm run test:real` (= real home+backend+client incl. activation/recovery + fake-provider push) | 2 pass / 0 fail (`logs/accepted-phone-release.log`) |
| phone-app | from `phone-app/apps/mobile`: `npm run typecheck` (= `tsc -p tsconfig.json --noEmit`, Expo `skipLibCheck`) | exit 0, 51 packages, zero ambient stubs — NOT a native build (`logs/accepted-mobile-types-release.log`) |
| phone-app | from `phone-app`: `node scripts/check-mobile-syntax.cjs` (syntax-only transpile, separate from semantic) | 52 checked / 0 fail (`logs/accepted-mobile-syntax-release.log`) |
| runtime live | reference only, no rerun: strict synthetic Muse final (response-block extract; delegate→parent waits→child→5-byte ORBIT→English→exactly 1 parent assistant) | pass, 47.538s, Meta Muse Spark 1.3 via actual SDK/remote opt-in (`logs/live-response-extraction-fix.jsonl`) |
| infra-server | from `infra-server`: `python3 -m unittest discover -s scripts -p 'test_*.py' -v` + `python3 scripts/upstream.py verify` | hygiene + upstream-source verification, local only |

No native-app install, Cloudflare-tunnel connection, public-endpoint,
IdP-deploy, native-push-delivery, or remote-CI execution is claimed:
default smoke stays loopback + fixture (no valid real provider needed);
Docker images / local Ollama / tunnel-DNS / IdP / APNs are explicit manual
provisions below.

## 7. Live synthetic check (already passed once — do not repeat live calls casually)

Strict final already passed (47.538s, `logs/live-response-extraction-fix.jsonl`):
Meta Muse Spark 1.3 via the actual SDK with explicit remote opt-in, synthetic
data only. No further live calls needed. Reference setup (runtime operator,
independent of home source):

```sh
# On the home host (runtime operator):
export HOME_MODEL_PROVIDER=openai HOME_MODEL_NAME="<meta-model>"
export HOME_MODEL_ENDPOINT="https://<meta-compatible-host>/v1"
export ME_RUNTIME_ALLOW_REMOTE=1 ME_RUNTIME_MODEL_API_KEY="<secret>"
export HOME_MODEL_USE_RESPONSES_API=1
npm run start:home   # then pair/submit per §3–§4 with a synthetic prompt
```

Reference expectation: task runs through `use_responses_api`, succeeds with
real output, artifacts verify by sha256. If the installed SDK lacks Responses
support the runtime falls back to Chat Completions with a stderr note — that
fallback must be reported, not mistaken for a Responses run. Household data
must never be used for live-model testing; synthetic prompts only. When
remote is enabled, the scoped prompt/history/tool context goes to that
provider (local Ollama default otherwise).

## 8. Implemented limitations + manual gates (concrete; never CI)

- Single-host SQLite (WAL); no replication or HA. No hosted private
  chat relay/storage — cloud holds coordination only.
- Home private API is direct paired HTTPS over the operator-provisioned
  named tunnel. Pairing invitation + device secret travel as JSON bodies:
  safe on loopback only; LAN/WAN needs that protected endpoint. Tunnel
  credential/DNS/`cloudflared`, real IdP, Docker images, local Ollama
  models, and native Expo/APNs delivery are explicit operator provisions
  (implementation, not stubs; parked until provided).
- Artifacts are verified before storage (regular files only, no symlinks,
  size and checksum match) and capped (10 MiB each, 50 per task, 100 MiB
  aggregate); violations fail the run.
- Sessions are opaque bearer tokens re-issued via device credential; no
  refresh rotation beyond re-issue. Failed pair/session attempts are
  per-IP rate limited; only the direct peer is counted by default.
- Revocation is enforced per home request (restored backups revoke
  sessions/devices/invitations — pair fresh). Cloud outage does not stop
  private phone↔home work: accepted home jobs continue, the coordinator
  loop backs off and reschedules (`suspended` only on 401/403 until the file
  changes), and phones keep direct private-API access. Optional
  Cloudflare-Access edge-policy propagation is manual where used.
- Approval expiry: each approval payload carries a bounded 24h `expiresAt`
  and is one-use (replay/decided/changed-state rejected); no administrative
  expiry UX.
- Resource/delegation limits (not a fair-share scheduler — no per-user
  fairness is claimed): home fanout 3 / depth 1 / root 4 guards + worker
  3-in-flight cap; anything beyond is out of scope.
- `run_code` is Docker one-shot only (no host fallback); container files
  are ephemeral tmpfs — bounded stdout/stderr streams are the artifacts
  (no `docker cp`). `browser_open` is the real isolated interactive
  Playwright browser (Docker `--network none` via vetted broker); missing
  Docker/image fails `prerequisite_missing` — production image build and
  local Docker runs are manual. Earlier host-Chrome DOM synthetic smoke
  passed; it does not stand in for the Docker run. Fixture runs prove the
  subprocess path only — never model quality. No semantic-memory / MCP /
  voice-calls production claims.
