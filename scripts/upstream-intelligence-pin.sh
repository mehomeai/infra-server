#!/bin/sh
# Pin the official Intelligence chart: pull the operator-pinned version and
# record version + digest in deploy/intelligence-chart.lock (committed).
# Usage: INTELLIGENCE_CHART_VERSION=0.1.0-rc.16 sh scripts/upstream-intelligence-pin.sh
set -eu
REPO_ROOT="$(dirname "$0")/.."
VERSION="${INTELLIGENCE_CHART_VERSION:-}"
[ -n "$VERSION" ] || { echo "pin: INTELLIGENCE_CHART_VERSION is required" >&2; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "pin: helm is required" >&2; exit 1; }
OUT="$(helm pull oci://ghcr.io/copilotkit/charts/intelligence --version "$VERSION" --destination "$(mktemp -d)" 2>&1)"
echo "$OUT"
ARCHIVE="$(echo "$OUT" | grep -oE '/[^ ]*intelligence-[0-9][^ ]*\.tgz' | head -1)"
[ -n "${ARCHIVE:-}" ] || { echo "pin: could not locate pulled chart archive" >&2; exit 1; }
DIGEST="$(sha256sum "$ARCHIVE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)"
printf '{"chart":"oci://ghcr.io/copilotkit/charts/intelligence","version":"%s","sha256":"%s"}\n' "$VERSION" "$DIGEST" \
  > "$REPO_ROOT/deploy/intelligence-chart.lock"
rm -f "$ARCHIVE"
echo "pin: locked $VERSION sha256:$DIGEST -> deploy/intelligence-chart.lock"
