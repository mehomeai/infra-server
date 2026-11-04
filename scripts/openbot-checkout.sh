#!/bin/sh
# Pinned OpenBot checkout for deployment (no in-repo huge assets).
# Usage: OPENBOT_REF=6bfee7... OPENBOT_DIR=/opt/openbot sh scripts/openbot-checkout.sh [--full]
# Default is a sparse checkout (<=30MiB) for verification on small disks.
# --full performs a complete blobless clone: REQUIRED to docker build images
# (sparse trees lack build inputs). Blobs fetch on demand during the build.
set -eu
REF="${OPENBOT_REF:-6bfee780c8e8d05141375ea55ebde33eefb3dbc0}"
DIR="${OPENBOT_DIR:-/opt/openbot}"
REPO="https://github.com/CopilotKit/OpenBot.git"
FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    *) echo "checkout: unknown flag $arg (only --full)" >&2; exit 1 ;;
  esac
done

case "$REF" in
  *[!0-9a-f]*|'') echo "OPENBOT_REF must be a full lowercase hex SHA" >&2; exit 1;;
esac
if [ "${#REF}" -ne 40 ]; then echo "OPENBOT_REF must be 40 chars" >&2; exit 1; fi

if [ -d "$DIR/.git" ]; then
  echo "checkout exists: $DIR (fetching pinned SHA)"
  git -C "$DIR" fetch --depth 1 origin "$REF" || true
  git -C "$DIR" checkout --detach "$REF"
else
  if [ "$FULL" = 1 ]; then
    echo "cloning full blobless OpenBot@$REF into $DIR (build-capable)"
    git clone --filter=blob:none "$REPO" "$DIR"
  else
    echo "cloning sparse OpenBot@$REF into $DIR (verification only; --full to build)"
    git clone --filter=blob:none --sparse "$REPO" "$DIR"
  fi
  git -C "$DIR" checkout --detach "$REF"
fi
if [ "$FULL" = 1 ]; then
  git -C "$DIR" sparse-checkout disable 2>/dev/null || true
else
  git -C "$DIR" sparse-checkout set --no-cone \
    LICENSE \
    server/Dockerfile server/package.json supervisor/Dockerfile agent-computer/Dockerfile \
    docker-compose.yml .env.example \
    server/src/app.ts server/src/copilot.ts server/src/config.ts server/src/index.ts \
    server/src/auth server/src/channels server/src/delivery server/src/tasks server/src/agents \
    server/src/computer supervisor/src shared/computer-control.ts \
    shared/intelligence-key.ts docs/architecture.md docs/configuration.md docs/deployment.md
fi
git -C "$DIR" rev-parse HEAD | grep -qx "$REF" || { echo "checkout HEAD != $REF" >&2; exit 1; }
echo "checkout OK: $(git -C "$DIR" rev-parse --short HEAD) $(du -sh "$DIR" | cut -f1)"
echo "verify digests:"
python3 scripts/upstream-openbot.py verify --fetch
echo "apply home patches:"
OPENBOT_CHECKOUT="$DIR" sh "$(dirname "$0")/../vendor/openbot/patches/apply.sh"
