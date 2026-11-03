#!/bin/sh
# Deterministic application of vendored OpenBot home-bridge patches.
# Usage: OPENBOT_CHECKOUT=/opt/openbot sh vendor/openbot/patches/apply.sh
# Idempotent: safe to re-run; verifies pin + patch order + resulting tree.
# Validates exact sha256 hashes from manifest.json (byte proof, not markers).
set -eu
PIN="6bfee780c8e8d05141375ea55ebde33eefb3dbc0"
DIR="${OPENBOT_CHECKOUT:-/opt/openbot}"
HERE="$(dirname "$0")"
MANIFEST="$HERE/manifest.json"

if [ ! -d "$DIR/.git" ]; then
  echo "apply.sh: not a git checkout: $DIR" >&2; exit 1
fi
HEAD="$(git -C "$DIR" rev-parse HEAD)"
if [ "$HEAD" != "$PIN" ]; then
  echo "apply.sh: checkout HEAD $HEAD != pinned $PIN (refusing)" >&2; exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "apply.sh: manifest.json missing: $MANIFEST" >&2; exit 1
fi
# Patch file itself must match the trusted manifest (tamper refusal).
python3 - "$HERE" <<'PY'
import hashlib, json, pathlib, sys
here = pathlib.Path(sys.argv[1])
manifest = json.loads((here / "manifest.json").read_text())
patch = here / manifest["patch"]
data = patch.read_bytes()
actual = hashlib.sha256(data).hexdigest()
if actual != manifest["patchSha256"]:
    print(f"apply.sh: patch tamper: {patch.name} sha {actual} != manifest {manifest['patchSha256']}", file=sys.stderr)
    sys.exit(1)
if manifest.get("baseCommit") != "6bfee780c8e8d05141375ea55ebde33eefb3dbc0":
    print("apply.sh: manifest baseCommit != pinned", file=sys.stderr)
    sys.exit(1)
PY
for p in "$HERE"/0001-*.patch; do
  [ -f "$p" ] || { echo "apply.sh: no patches found" >&2; exit 1; }
  name="$(basename "$p")"
  if git -C "$DIR" apply --reverse --check "$p" >/dev/null 2>&1; then
    echo "apply.sh: already applied: $name"
  else
    git -C "$DIR" apply --check "$p" || { echo "apply.sh: patch does not apply cleanly: $name" >&2; exit 1; }
    git -C "$DIR" apply "$p"
    echo "apply.sh: applied: $name"
  fi
done
# Byte-proof verification: every approved patched file must equal its
# manifest post hash; unmodified seams must still equal their original hash.
python3 - "$DIR" "$MANIFEST" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads(pathlib.Path(sys.argv[2]).read_text())
def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
for name, entry in manifest["files"].items():
    target = root / name
    if not target.is_file():
        print(f"apply.sh: {name} missing after apply", file=sys.stderr)
        sys.exit(1)
    actual = sha(target)
    if actual != entry["postSha256"]:
        print(f"apply.sh: {name} post hash {actual} != manifest {entry['postSha256']}", file=sys.stderr)
        sys.exit(1)
for name, want in manifest.get("unmodified", {}).items():
    target = root / name
    if target.is_file() and sha(target) != want:
        print(f"apply.sh: unmodified seam drift: {name}", file=sys.stderr)
        sys.exit(1)
PY
test -f "$DIR/server/src/home-bridge.ts" || { echo "apply.sh: home-bridge.ts missing after apply" >&2; exit 1; }
grep -q "wrapAuthWithHomeBridge" "$DIR/server/src/index.ts" || { echo "apply.sh: index.ts hook missing after apply" >&2; exit 1; }
grep -q "meHomeBridgeConfigured" "$DIR/server/src/config.ts" || { echo "apply.sh: config.ts bridge authority missing after apply" >&2; exit 1; }
grep -q "bridgeSessionCache" "$DIR/server/src/home-bridge.ts" || { echo "apply.sh: home-bridge.ts memoization missing after apply" >&2; exit 1; }
echo "apply.sh: OK ($PIN, home bridge active)"
