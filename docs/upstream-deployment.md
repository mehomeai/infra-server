# Upstream deployment recipe (FULL primary, CORE dev/partial)

User decision: FULL OpenBot platform is PRIMARY (licensed self-hosted
Intelligence, home-owned; no managed cloud default). Standalone CORE
(computer plane only) remains as explicit dev/partial, never presented as the
full goal.

Pinned source: `CopilotKit/OpenBot` `@ 6bfee78...` (MIT). Lock +
verification: `vendor/openbot/upstream.json`,
`python3 scripts/upstream-openbot.py verify [--fetch|--deployed DIR]`.
Patch: `0001-home-identity-bridge` (`vendor/openbot/patches/` ledger +
`apply.sh`; seam, not fork). Deployed-tree verification (local hashes + pin
+ applied patch): `verify --deployed`.

## Fetch (sparse default ≤30MiB for this Mac; --full to build)

```sh
OPENBOT_CHECKOUT=/opt/openbot OPENBOT_REF=6bfee780c8e8d05141375ea55ebde33eefb3dbc0 \
  sh scripts/openbot-checkout.sh [--full]
```

Default clones `--filter=blob:none --sparse` (verification only) with the
fixed sparse paths (Dockerfiles, compose, `server/src/{app,copilot,config,
index,auth,channels,delivery,tasks,agents,computer}`, `supervisor/src`,
`shared/*`, selected docs), re-verifies digests, and applies the home patch
ledger. `--full` performs a complete blobless clone: REQUIRED to
`docker build` images (sparse trees lack build inputs). CI Linux resolves
image digests (`docker inspect`); this Mac has no Docker.

## FULL (primary, licensed self-hosted Intelligence)

`ME_UPSTREAM_MODE=full`. Single command (Linux operator host):

```sh
ME_DATA_DIR=$HOME/me-data OPENBOT_CHECKOUT=$HOME/openbot \
  INTELLIGENCE_CHART_VERSION=<pinned> \
  ME_KUBE_CONTEXT=me-home ME_KUBE_API_URL=https://<cluster>:6443 \
  HARNESS_CONTEXT_DIR=$HOME/harness-ctx \
  sh scripts/upstream-full-install.sh
```

which runs: operator data dir (0700) → pinned checkout (`--full`) →
`verify --deployed` → harness stage/build from B's canonical context +
digest record → kube-context guard (refuses wrong-cluster deploys) →
chart render validation against the pinned schema → official Intelligence
chart install (`oci://ghcr.io/copilotkit/charts/intelligence`, pinned
version + digest lock `deploy/intelligence-chart.lock`, single-node overlay
`deploy/upstream-intelligence-values.yaml` layered with the operator's
secrets file) → `docker compose -f deploy/upstream-full.yml
--profile harness up -d --build` (server + worker + migrate + Postgres +
supervisor + computers + launcher-built harness, all from the pinned
checkout) → doctor + live-evidence cache. Requires `DATABASE_URL`,
`KEY_ENCRYPTION_KEY`, `ME_HOME_BRIDGE_SECRET`, `INTELLIGENCE_*`,
`CPK_INTELLIGENCE_API_KEY` (+ `COPILOTKIT_LICENSE_TOKEN` on the
Intelligence deployment), BetterAuth set. No mandatory `/opt` or `/run`
paths; no destructive migration (thread-culler refused, down -v refused).
See `docs/upstream-full.md` for the operator env + identity hook. Doctor must
report `READY` on all components (authenticated entitlement + native auth
probe included); without credentials/SDK/checkout it reports `NEEDS_INPUT`
honestly (never fake `READY`). Linux CI validates the licensed gate + CORE
Docker path + chart render from the published branch.

## CORE (licence-free, explicit dev/partial)

`ME_UPSTREAM_MODE=core`. Needs only (dev/partial; FULL is primary):

```sh
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4500
SUPERVISOR_TOKEN=<long-random>   # supervisor auth (Bearer)
COMPUTER_TOKEN=<long-random>     # computer auth (x-openbot-computer-token)
COMPUTER_IMAGE=openbot-agent-computer:latest
COMPUTER_NAMESPACE=openbot
OPENBOT_CHECKOUT=/opt/openbot
```

Start actual upstream services:

```sh
SUPERVISOR_TOKEN=... COMPUTER_TOKEN=... \
  docker compose -f deploy/upstream-core.yml up -d --build
# or inside the pinned checkout:
# docker compose --profile harness up -d agent-computer supervisor
```

Doctor: `node --experimental-transform-types src/cli.mjs upstream-doctor`
(or import `checkUpstreamPlatform` from `src/upstream-doctor.mjs`).
`READY` = pin + supervisor `/health {ok,docker}` + token list + per-user
boundary. Missing tokens → `NEEDS_INPUT`. No CopilotKit license needed.

## FULL (optional, licensed self-hosted Intelligence)

`ME_UPSTREAM_MODE=full`. Reuses the full upstream Postgres/server/routines
stack from the same pinned checkout. Requires additionally `DATABASE_URL`,
`KEY_ENCRYPTION_KEY` (base64 32B, example refused), `INTELLIGENCE_API_URL`,
`INTELLIGENCE_GATEWAY_WS_URL`, `CPK_INTELLIGENCE_API_KEY` (+
`COPILOTKIT_LICENSE_TOKEN` on self-hosted Intelligence), BetterAuth provider
set + `INITIAL_ADMIN_EMAILS`. Refusals (fail-closed):

- `OPENBOT_SINGLE_USER=true` → FAILED (dev-only).
- Managed `*.copilotkit.ai` Intelligence URL without
  `ME_UPSTREAM_ALLOW_MANAGED_INTELLIGENCE=1` → FAILED (home privacy default:
  no managed cloud conversation storage).
- Missing key/OAuth → `NEEDS_INPUT` (honest, never fake READY).

The doctor NEVER reports READY from an empty health proxy; it checks pin +
deployed checkout (git HEAD == lock, approved seam only, no unapproved
drift), versions, token validation, per-user admin/User fleet + native
roster probes, the license gate, and the authenticated Intelligence
entitlement. `probe=false` never yields READY.

## Verifying host: pinned Intelligence SDK install (for the doctor)

The host that runs `upstream-doctor` needs the pinned official SDK for the
authenticated entitlement read (`@copilotkit/runtime@1.83.0`, the same
package the upstream server builds its client from). B's Python harness
image does NOT provide the Node SDK — install it on the verifying host:

```sh
mkdir -p $HOME/me-intel-sdk && cd $HOME/me-intel-sdk
npm init -y >/dev/null
npm i --no-save @copilotkit/runtime@1.83.0
INTELLIGENCE_SDK_ROOT=$HOME/me-intel-sdk \
  node --experimental-transform-types src/cli.mjs upstream-doctor
```

A version mismatch is NEEDS_INPUT (align to the pin); the C installer and
CI use the same recipe. No credentials are needed to implement the check,
only to run it live.

## Storage (for C backup owner)

Private volumes/host data: `postgres-data` (`/var/lib/postgresql/data`),
`agent-workspace:/workspace`, `agent-profiles:/profiles`, plus bind
`./.openbot`, `./egress.env`, `./.langchain` when present. Machine contract:
`results/datastorage-contract.json`. No Docker state in git; snapshots via
existing upstream helpers (`pg_dump`, volume copy), no destructive migration,
legacy conversations preserved.

## Manual gates (never automatic)

Live model backend, Docker images, provisioned tunnel, provider OAuth, and
Intelligence credentials remain operator inputs (`NEEDS_INPUT`). Absent
backends fail honestly.
