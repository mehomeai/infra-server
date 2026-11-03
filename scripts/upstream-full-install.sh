#!/bin/sh
# Me home FULL installer (Linux operator host; NOT for day-to-day Mac use).
# Single-command bootstrap: pinned checkout (+patches) -> verify -> harness
# stage/build (+digest) -> official Intelligence chart -> compose stack ->
# doctor (+live-evidence cache). Secrets stay in operator files (0600);
# nothing secret is written to the repo. No mandatory /opt or /run paths;
# every location is operator-owned and configurable. No data migration runs.
#
# Usage:
#   ME_DATA_DIR=$HOME/me-data OPENBOT_CHECKOUT=$HOME/openbot \
#   INTELLIGENCE_CHART_VERSION=0.1.0-rc.16 \
#   sh scripts/upstream-full-install.sh
#
# Inputs (env; no args, no prompts):
#   ME_DATA_DIR            operator-owned dir (default $HOME/me-data); holds
#                          upstream-full.env (0600, required), harness digest,
#                          doctor cache. Created 0700 when missing (refuses
#                          world-writable).
#   OPENBOT_CHECKOUT       pinned checkout dir (default $ME_DATA_DIR/openbot)
#   ME_KUBE_CONTEXT, ME_KUBE_API_URL, ME_KUBE_NAMESPACE, INTEL_VALUES, ...
#                          see scripts/upstream-kube-guard.sh + helm values.
#   HARNESS_CONTEXT_DIR    B canonical staged context (Dockerfile + sources
#                          + constraints-me.txt via stage_agent_image_context.py),
#                          OR HARNESS_PREBUILT_IMAGE (already-built local image).
#   HARNESS_IMAGE          image name to build/use (default
#                          openbot-agent-langgraph-agui:6bfee780c8e8)
#
# Prerequisites (checked, never installed here): docker, node, helm>=3.12,
# kubectl (for Intelligence), git. Local Docker evaluation
# (`copilotkit local ...`) is a separate PREVIEW, never production.
set -eu
REPO_ROOT="$(dirname "$0")"
ME_DATA_DIR="${ME_DATA_DIR:-$HOME/me-data}"
CHECKOUT="${OPENBOT_CHECKOUT:-$ME_DATA_DIR/openbot}"
ENV_FILE="${ME_UPSTREAM_ENV_FILE:-$ME_DATA_DIR/upstream-full.env}"
INTEL_VALUES="${INTEL_VALUES:-$ME_DATA_DIR/my-intel-values.yaml}"
CHART_VERSION="${INTELLIGENCE_CHART_VERSION:-}"
HARNESS_IMAGE="${HARNESS_IMAGE:-openbot-agent-langgraph-agui:6bfee780c8e8}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "install: missing required tool: $1" >&2; exit 1; }
}
need docker; need node; need git

# Operator data dir: created private, never world-writable, never /run.
if [ ! -d "$ME_DATA_DIR" ]; then
  mkdir -p -m 0700 "$ME_DATA_DIR" || { echo "install: cannot create $ME_DATA_DIR" >&2; exit 1; }
fi
if [ "$(stat -c %a "$ME_DATA_DIR" 2>/dev/null || stat -f %Lp "$ME_DATA_DIR")" != "700" ]; then
  echo "install: refusing: $ME_DATA_DIR is not mode 0700" >&2; exit 1
fi
[ -f "$ENV_FILE" ] || { echo "install: operator env file missing: $ENV_FILE (0600, see docs/upstream-full.md)" >&2; exit 1; }
if [ "$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")" != "600" ]; then
  echo "install: refusing: $ENV_FILE is not mode 0600" >&2; exit 1
fi
# Unique home installation namespace, persisted once (operator-owned file).
# The upstream server falls back to the tenant package id when unset, but a
# stable unique DEPLOYMENT_ID keeps thread identity + installation namespace
# distinct across homes.
if ! grep -qE '^[A-Za-z_]*DEPLOYMENT_ID=' "$ENV_FILE"; then
  DEPLOYMENT_ID="me-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '\nDEPLOYMENT_ID="%s"\n' "$DEPLOYMENT_ID" >> "$ENV_FILE"
  echo "install: persisted generated DEPLOYMENT_ID=$DEPLOYMENT_ID to $ENV_FILE"
fi
# Me tenant package (personal agent record) must exist; the compose mount is
# read-only and the upstream default would otherwise boot sample content.
TENANT_DIR="${ME_TENANT_PACKAGE_DIR:-$REPO_ROOT/../deploy/tenant-package}/me"
[ -f "$TENANT_DIR/agents.yaml" ] || { echo "install: tenant package missing: $TENANT_DIR/agents.yaml (personal Me agent record required; never the upstream sample)" >&2; exit 1; }

# No destructive data migration, ever: refuse to run against a compose
# project that would drop volumes.
if [ -n "${ME_ALLOW_DOWN_V:-}" ]; then
  echo "install: refusing: destructive compose down -v is never part of install" >&2; exit 1
fi

echo "==> 1/6 pinned checkout (+patches)"
OPENBOT_REF="${OPENBOT_REF:-6bfee780c8e8d05141375ea55ebde33eefb3dbc0}" OPENBOT_DIR="$CHECKOUT" \
  sh "$REPO_ROOT/openbot-checkout.sh" --full

echo "==> 2/6 verify deployed checkout (local hashes + pin + patch)"
python3 "$REPO_ROOT/upstream-openbot.py" verify --deployed "$CHECKOUT"

echo "==> 3/6 native harness: stage/build B canonical context, record digest"
if [ -n "${HARNESS_PREBUILT_IMAGE:-}" ]; then
  docker image inspect "$HARNESS_PREBUILT_IMAGE" >/dev/null \
    || { echo "install: HARNESS_PREBUILT_IMAGE not present locally: $HARNESS_PREBUILT_IMAGE" >&2; exit 1; }
  HARNESS_IMAGE="$HARNESS_PREBUILT_IMAGE"
else
  [ -n "${HARNESS_CONTEXT_DIR:-}" ] || { echo "install: HARNESS_CONTEXT_DIR or HARNESS_PREBUILT_IMAGE is required (B canonical recipe; no published image exists)" >&2; exit 1; }
  [ -f "$HARNESS_CONTEXT_DIR/Dockerfile" ] || { echo "install: HARNESS_CONTEXT_DIR lacks Dockerfile: $HARNESS_CONTEXT_DIR" >&2; exit 1; }
  docker build -t "$HARNESS_IMAGE" "$HARNESS_CONTEXT_DIR"
fi
DIGEST="$(docker image inspect --format '{{.Id}} {{index .RepoDigests 0}}' "$HARNESS_IMAGE" 2>/dev/null || docker image inspect --format '{{.Id}}' "$HARNESS_IMAGE")"
printf 'image=%s\ndigest=%s\nbuilt=%s\n' "$HARNESS_IMAGE" "$DIGEST" "$(date -u +%FT%TZ)" > "$ME_DATA_DIR/harness-image.digest"
chmod 600 "$ME_DATA_DIR/harness-image.digest"
echo "install: harness $HARNESS_IMAGE ($DIGEST)"

echo "==> 4/6 official Intelligence chart (licensed self-hosted, production)"
if [ -z "$CHART_VERSION" ]; then
  echo "install: INTELLIGENCE_CHART_VERSION is required (NEEDS_INPUT: pin a released chart version)" >&2; exit 1
fi
need helm; need kubectl
sh "$REPO_ROOT/upstream-kube-guard.sh"
INTELLIGENCE_CHART_VERSION="$CHART_VERSION" sh "$REPO_ROOT/upstream-intelligence-pin.sh"
if grep -qE 'threadCuller:\s*$' "$INTEL_VALUES" 2>/dev/null && grep -A1 -E 'threadCuller:\s*$' "$INTEL_VALUES" | grep -qE 'enabled:\s*true'; then
  echo "install: refusing: threadCuller.enabled=true in operator values (destructive cleanup is never enabled by install)" >&2; exit 1
fi
CTX="${ME_KUBE_CONTEXT:?ME_KUBE_CONTEXT required}"
NS="${ME_KUBE_NAMESPACE:-copilot-intelligence}"
# Render validation against the exact pinned chart schema (client-side, no
# cluster, no license): refuses invented values keys and wrong shapes before
# any mutation. Asserts the home-required resources exist and the destructive
# thread-culler CronJob does not.
helm template copilot-intelligence oci://ghcr.io/copilotkit/charts/intelligence \
  --kube-context "$CTX" \
  --version "$CHART_VERSION" \
  -f "$REPO_ROOT/../deploy/upstream-intelligence-values.yaml" \
  -f "$INTEL_VALUES" \
  -n "$NS" > "$ME_DATA_DIR/intel-render.yaml"
for want in "kind: Deployment" "kind: Job"; do
  grep -q "$want" "$ME_DATA_DIR/intel-render.yaml" \
    || { echo "install: refusing: chart render lacks $want (schema/values drift?)" >&2; exit 1; }
done
grep -q "app-api" "$ME_DATA_DIR/intel-render.yaml" \
  || { echo "install: refusing: chart render lacks app-api (schema/values drift?)" >&2; exit 1; }
if grep -q "thread-culler" "$ME_DATA_DIR/intel-render.yaml"; then
  echo "install: refusing: chart render contains thread-culler (must stay disabled)" >&2; exit 1
fi
helm upgrade --install copilot-intelligence oci://ghcr.io/copilotkit/charts/intelligence \
  --kube-context "$CTX" \
  --version "$CHART_VERSION" \
  -f "$REPO_ROOT/../deploy/upstream-intelligence-values.yaml" \
  -f "$INTEL_VALUES" \
  -n "$NS" --create-namespace --wait --timeout 10m

echo "==> 5/6 FULL compose stack"
set -a; . "$ENV_FILE"; set +a
export ME_UPSTREAM_ENV_FILE="$ENV_FILE" OPENBOT_CHECKOUT="$CHECKOUT" HARNESS_IMAGE="$HARNESS_IMAGE"
docker compose -f "$REPO_ROOT/../deploy/upstream-full.yml" --profile harness up -d --build

echo "==> 6/6 doctor (trusted upstream-platform-v1 + live-evidence cache)"
set -a; . "$ENV_FILE"; set +a
node --experimental-transform-types "$REPO_ROOT/../src/cli.mjs" upstream-doctor --cache "$ME_DATA_DIR/doctor-cache.json"
echo "install: OK (review doctor state above; NEEDS_INPUT names operator gates, FAILED blocks)"
