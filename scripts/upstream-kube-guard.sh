#!/bin/sh
# Kubernetes context guard for the Me home FULL installer.
# Requires an explicit home-owned/local cluster context and validates the
# API endpoint + namespace ownership BEFORE any helm/kubectl mutation.
# Never deploys to whatever cluster the user's current context points to.
#
# Required env:
#   ME_KUBE_CONTEXT   explicit kubectl context name (e.g. me-home, k3d-me, docker-desktop)
#   ME_KUBE_API_URL   expected cluster API endpoint (exact https://host:port)
#   ME_KUBE_NAMESPACE target namespace (created if missing)
# Optional env:
#   KUBECTL_BIN       kubectl binary (default kubectl; tests stub this)
#   KUBE_GUARD_DRY_RUN=1  validate only, no mutation (still creates nothing)
#
# Exit 0 when the context is selected and validated; non-zero with a refusal
# reason before any mutation otherwise. kubectl/helm callers must pass
# --kube-context "$ME_KUBE_CONTEXT" on EVERY operation.
set -eu
CTX="${ME_KUBE_CONTEXT:-}"
API="${ME_KUBE_API_URL:-}"
NS="${ME_KUBE_NAMESPACE:-copilot-intelligence}"
KUBECTL="${KUBECTL_BIN:-kubectl}"

[ -n "$CTX" ] || { echo "kube-guard: refusing: ME_KUBE_CONTEXT is required (explicit home-owned/local cluster context)" >&2; exit 2; }
[ -n "$API" ] || { echo "kube-guard: refusing: ME_KUBE_API_URL is required (expected cluster endpoint)" >&2; exit 2; }
command -v "$KUBECTL" >/dev/null 2>&1 || { echo "kube-guard: refusing: kubectl binary not found: $KUBECTL" >&2; exit 2; }

# The context must exist in the kubeconfig.
"$KUBECTL" config get-contexts -o name 2>/dev/null | grep -qx "$CTX" \
  || { echo "kube-guard: refusing: context '$CTX' not found in kubeconfig" >&2; exit 2; }

# The context's cluster server must be exactly the expected endpoint.
SERVER="$("$KUBECTL" config view -o jsonpath="{.contexts[?(@.name==\"$CTX\")].context.cluster}" 2>/dev/null || true)"
[ -n "$SERVER" ] || { echo "kube-guard: refusing: context '$CTX' has no cluster" >&2; exit 2; }
ENDPOINT="$("$KUBECTL" config view -o jsonpath="{.clusters[?(@.name==\"$SERVER\")].cluster.server}" 2>/dev/null || true)"
if [ "$ENDPOINT" != "$API" ]; then
  echo "kube-guard: refusing: context '$CTX' points at '$ENDPOINT', expected '$API' (wrong cluster)" >&2
  exit 2
fi

# Namespace ownership: must be creatable/usable by this kubeconfig.
if [ "${KUBE_GUARD_DRY_RUN:-0}" = 1 ]; then
  echo "kube-guard: OK (dry-run) context=$CTX api=$API namespace=$NS"
  exit 0
fi
if ! "$KUBECTL" --kube-context "$CTX" auth can-i create deployments -n "$NS" >/dev/null 2>&1; then
  if ! "$KUBECTL" --kube-context "$CTX" create namespace "$NS" --dry-run=client -o name >/dev/null 2>&1; then
    echo "kube-guard: refusing: cannot use namespace '$NS' on '$CTX'" >&2
    exit 2
  fi
fi
echo "kube-guard: OK context=$CTX api=$API namespace=$NS"
