#!/usr/bin/env python3
"""Verify/pin the immutable OpenBot computer-platform source subset.

Upstream: CopilotKit/OpenBot @ pinned main SHA (see vendor/openbot/upstream.json).
This repo does NOT vendor OpenBot source: deployment uses a full pinned
`git clone --sparse` checkout executing actual upstream Dockerfiles/services.
This lock records the revision + SHA-256 of protocol-critical files; `verify`
checks lock format offline, `check`/`verify --fetch` re-fetches pinned files
and compares digests. Candidate promotion stays in a separate read-only CI job.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VENDOR = Path('vendor/openbot')
REPOSITORY = 'CopilotKit/OpenBot'
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')
LIMIT = 1024 * 1024
# Protocol-critical allowlist only (computer/supervisor + Docker recipe + docs).
# Full deployment uses a pinned checkout; this list is the import-verification
# surface, not a vendored copy.
FILES = (
    'LICENSE',
    'server/Dockerfile',
    'supervisor/Dockerfile',
    'agent-computer/Dockerfile',
    'docker-compose.yml',
    '.env.example',
    'server/src/app.ts',
    'server/src/copilot.ts',
    'server/src/config.ts',
    'server/src/computer/routes.ts',
    'server/src/computer/gateway.ts',
    'server/src/computer/client.ts',
    'server/src/computer/supervisor.ts',
    'server/src/computer/computer-key.ts',
    'server/src/computer/provider.ts',
    'server/src/computer/policy.ts',
    'server/src/computer/schema.ts',
    'supervisor/src/index.ts',
    'supervisor/src/docker.ts',
    'supervisor/src/names.ts',
    'supervisor/src/authorisation.ts',
    'supervisor/src/environment.ts',
    'shared/intelligence-key.ts',
    'shared/computer-control.ts',
    'docs/architecture.md',
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def manifest_at(base):
    path = base / 'upstream.json'
    if path.is_symlink():
        raise ValueError('Manifest must be a regular file')
    manifest = json.loads(path.read_text())
    if manifest.get('schema') != 1 or manifest.get('repository') != REPOSITORY:
        raise ValueError('Unsupported manifest or upstream repository')
    if manifest.get('branch') != 'main' or not SHA.fullmatch(manifest.get('revision', '')):
        raise ValueError('Expected main and an immutable full commit SHA')
    if set(manifest.get('files', {})) != set(FILES):
        raise ValueError('Manifest paths differ from the fixed import allowlist')
    if not all(isinstance(v, str) and DIGEST.fullmatch(v) for v in manifest['files'].values()):
        raise ValueError('Invalid source digest')
    return manifest


def verify_base(base):
    return manifest_at(base)


# Approved patch footprint in a deployed checkout (parity with the JS
# doctor, src/upstream-doctor.mjs): only the F patch seam may differ from
# the pinned commit, and only these new files may appear.
APPROVED_MODIFIED = frozenset({'server/src/index.ts', 'server/src/config.ts'})
APPROVED_UNTRACKED = (
    'server/src/home-bridge.ts', 'node_modules/', '.openbot/', 'egress.env', '.langchain/',
)


def patch_manifest_at(base):
    """Load the F-owned patch manifest (vendor/openbot/patches/manifest.json).

    Fail-closed: the manifest is REQUIRED — missing, unreadable or
    malformed is a refusal, never a silent downgrade to marker-only
    checks. Its schema is authoritative (patch-auth-v3): files maps each
    patched path to {originalSha256, postSha256}; unmodified maps seam
    paths to plain digests. The vendored patch file itself must match
    patchSha256 (the tamper proof apply.sh performs before applying).
    """
    path = base / 'patches' / 'manifest.json'
    if path.is_symlink():
        raise ValueError('Patch manifest must be a regular file')
    try:
        manifest = json.loads(path.read_text())
    except OSError:
        raise ValueError('Patch manifest missing or unreadable: '
                         'vendor/openbot/patches/manifest.json (required; '
                         'post-hash verification is never optional)')
    if manifest.get('schema') != 1 or manifest.get('repository') != REPOSITORY:
        raise ValueError('Unsupported patch manifest or upstream repository')
    if not SHA.fullmatch(manifest.get('baseCommit', '')):
        raise ValueError('Patch manifest baseCommit is not an immutable full commit SHA')
    files = manifest.get('files')
    if not isinstance(files, dict) or not files:
        raise ValueError('Patch manifest has no files map')
    for name, entry in files.items():
        if not isinstance(entry, dict) or not DIGEST.fullmatch(entry.get('postSha256') or ''):
            raise ValueError(f'Patch manifest entry lacks a valid postSha256: {name}')
        original = entry.get('originalSha256')
        if original is not None and not DIGEST.fullmatch(original):
            raise ValueError(f'Patch manifest entry has a malformed originalSha256: {name}')
    unmodified = manifest.get('unmodified', {})
    if not isinstance(unmodified, dict) or not all(
            isinstance(v, str) and DIGEST.fullmatch(v) for v in unmodified.values()):
        raise ValueError('Patch manifest unmodified digests are malformed')
    patch_name = manifest.get('patch', '')
    patch_digest = manifest.get('patchSha256', '')
    if not patch_name or Path(patch_name).name != patch_name or not DIGEST.fullmatch(patch_digest):
        raise ValueError('Patch manifest lacks a pinned patch file digest')
    try:
        patch_bytes = (base / 'patches' / patch_name).read_bytes()
    except OSError:
        raise ValueError(f'Vendored patch file missing: {patch_name}')
    if digest(patch_bytes) != patch_digest:
        raise ValueError('Vendored patch file tampered: sha256 != patch manifest patchSha256')
    return manifest


def tracked_drift(root):
    """Refuse unexpected tracked drift / unapproved new files (JS parity).

    A deployed checkout at the pinned HEAD may differ ONLY by the approved
    patch footprint: tracked modifications within APPROVED_MODIFIED
    (index.ts mandatory — an untouched seam means the patch was never
    applied) and new files within APPROVED_UNTRACKED.
    """
    status = subprocess.run(
        ['git', '-C', str(root), 'status', '--porcelain=v1', '-z',
         '--untracked-files=all'],
        capture_output=True, text=True, timeout=30,
    )
    if status.returncode != 0:
        raise ValueError('Deployed checkout git status unreadable')
    tokens = status.stdout.split('\0')
    modified = set()
    created = []
    i = 0
    while i < len(tokens):
        entry = tokens[i]
        i += 1
        if not entry:
            continue
        code, path = entry[:2], entry[3:]
        if 'R' in code or 'C' in code:
            # -z rename/copy: the NEXT token is the source path.
            if i < len(tokens):
                modified.add(tokens[i])
                i += 1
        if code == '??':
            created.append(path)
        else:
            modified.add(path)
    for path in sorted(modified):
        if path not in APPROVED_MODIFIED:
            raise ValueError(
                f'Unexpected tracked drift (only the approved patch seam may differ): {path}')
    if 'server/src/index.ts' not in modified:
        raise ValueError(
            'Assembly seam untouched (approved patch not applied): server/src/index.ts unmodified')
    for path in created:
        if not any(path == a or path.startswith(a) for a in APPROVED_UNTRACKED):
            raise ValueError(f'Unapproved new source file in deployed checkout: {path}')


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'mehomeai-upstream-check/1'})
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Upstream response exceeds size limit')
    data.decode('utf-8')
    return data


def fetch_pinned(revision, fetch=download):
    sources = {}
    for name in FILES:
        sources[name] = fetch(f'https://raw.githubusercontent.com/{REPOSITORY}/{revision}/{name}')
        if len(sources[name]) > LIMIT:
            raise ValueError('Upstream source exceeds size limit')
        sources[name].decode('utf-8')
    if not sources['LICENSE'].strip():
        raise ValueError('Upstream license is empty')
    return sources


def verify_fetched(base, fetch=download):
    manifest = verify_base(base)
    sources = fetch_pinned(manifest['revision'], fetch)
    for name, content in sources.items():
        if digest(content) != manifest['files'][name]:
            raise ValueError(f'Pinned source drift or manifest mismatch: {name}')
    return manifest


def latest_revision(fetch=download):
    body = json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/commits/main'))
    revision = body.get('sha', '')
    if not SHA.fullmatch(revision):
        raise ValueError('GitHub did not return an immutable commit SHA')
    return revision


# Candidate bundle for review (read-only): fetch every lock file PLUS the
# patched assembly seam files (index.ts + config.ts, the F patch footprint)
# at a candidate revision and record digests. The bundle never executes
# candidate code; CI tests whether the home patch still applies to the
# candidate seam and opens a review PR (no merge).
BUNDLE_EXTRA = ('server/src/index.ts', 'server/src/config.ts')


def fetch_bundle(revision, bundle_dir, fetch=download):
    if not SHA.fullmatch(revision or ''):
        raise ValueError('Invalid revision')
    names = list(FILES) + list(BUNDLE_EXTRA)
    sources = {}
    for name in names:
        content = fetch(f'https://raw.githubusercontent.com/{REPOSITORY}/{revision}/{name}')
        if len(content) > LIMIT:
            raise ValueError('Upstream source exceeds size limit')
        content.decode('utf-8')
        sources[name] = content
    bundle = Path(bundle_dir)
    bundle.mkdir(parents=True, exist_ok=True)
    for name, content in sources.items():
        target = bundle / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    report = {
        'repository': REPOSITORY,
        'revision': revision,
        'files': {name: digest(sources[name]) for name in FILES},
        'index_sha256': digest(sources['server/src/index.ts']),
    }
    (bundle / 'revision.json').write_text(json.dumps(report, indent=2))
    return report


# Files a deployed checkout must carry beyond the lock allowlist: the
# assembly seam the home patch hooks plus the applied bridge itself.
DEPLOYED_REQUIRED = (
    'server/src/index.ts',
    'server/src/home-bridge.ts',
    'docker-compose.yml',
    'server/Dockerfile',
)

HOME_BRIDGE_MARKERS = (
    'wrapAuthWithHomeBridge',
    'ME_HOME_BRIDGE_SECRET',
    'timingSafeEqual',
)


def verify_deployed(deployed, vendor_base=None):
    """Verify a DEPLOYED checkout locally: pin, patch manifest, local hashes.

    Unlike `verify --fetch` (remote files), this reads the operator's tree
    (patch-auth-v3 verify list):
    - HEAD must equal the pin, and the REQUIRED patch manifest
      (vendor/openbot/patches/manifest.json) must anchor to the same pin;
    - git status must show ONLY the approved patch footprint (tracked
      drift or unapproved new files are refused);
    - every lock file's LOCAL sha256 must match the lock, EXCEPT files the
      patch legitimately rewrites: those are pinned by their manifest
      postSha256 instead (the seam exception — the lock holds the ORIGINAL
      pre-patch digests, so demanding them here would refuse every real
      patched deployment);
    - every manifest-pinned patched file (including seam files outside
      the lock allowlist: index.ts, the new home-bridge.ts) must match its
      postSha256 exactly, and unmodified seams must still match wherever
      present (sparse verification checkouts may omit them, apply.sh
      parity; a tracked deletion is refused by the drift check);
    - patch markers remain defense-in-depth only, never sole proof.
    """
    base = vendor_base if vendor_base is not None else ROOT / VENDOR
    manifest = verify_base(base)
    patch = patch_manifest_at(base)
    pin = manifest['revision']
    if patch['baseCommit'] != pin:
        raise ValueError(f"Patch manifest baseCommit {patch['baseCommit']} != pinned {pin}")
    root = Path(deployed)
    if not (root / '.git').is_dir():
        raise ValueError(f'Deployed checkout is not a git tree: {deployed}')
    head = subprocess.run(
        ['git', '-C', str(root), 'rev-parse', 'HEAD'],
        capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    if head != pin:
        raise ValueError(f'Deployed HEAD {head} != pinned {pin}')
    tracked_drift(root)
    for name in DEPLOYED_REQUIRED:
        if not (root / name).is_file():
            raise ValueError(f'Deployed checkout lacks required file: {name}')
    patched = patch['files']

    def checked_bytes(name):
        data = (root / name).read_bytes()
        if len(data) > LIMIT:
            raise ValueError(f'Deployed file exceeds size limit: {name}')
        return data

    for name, want in manifest['files'].items():
        entry = patched.get(name)
        if entry is not None and entry.get('originalSha256') is not None \
                and entry['originalSha256'] != want:
            raise ValueError(f'Patch manifest original hash disagrees with the vendor lock: {name}')
        want_digest = entry['postSha256'] if entry is not None else want
        if digest(checked_bytes(name)) != want_digest:
            kind = 'post-patch drift vs patch manifest' if entry is not None else 'drift vs lock'
            raise ValueError(f'Deployed file {kind}: {name}')
    for name, entry in patched.items():
        if name in manifest['files']:
            continue
        if not (root / name).is_file():
            raise ValueError(f'Deployed checkout lacks manifest-pinned patched file: {name}')
        if digest(checked_bytes(name)) != entry['postSha256']:
            raise ValueError(f'Deployed file post-patch drift vs patch manifest: {name}')
    for name, want in patch.get('unmodified', {}).items():
        target = root / name
        if target.is_file() and digest(checked_bytes(name)) != want:
            raise ValueError(f'Unmodified seam drift vs patch manifest: {name}')
    bridge = (root / 'server/src/home-bridge.ts').read_text()
    for marker in HOME_BRIDGE_MARKERS:
        if marker not in bridge:
            raise ValueError(f'home-bridge.ts lacks applied-patch marker: {marker}')
    index = (root / 'server/src/index.ts').read_text()
    if 'wrapAuthWithHomeBridge(homeAuth' not in index:
        raise ValueError('index.ts lacks the home-bridge assembly hook')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['verify', 'check', 'fetch-bundle'])
    parser.add_argument('--fetch', action='store_true', help='verify also re-fetches pinned files and compares digests')
    parser.add_argument('--deployed', help='verify a DEPLOYED checkout dir (local hashes + pin + applied patch)')
    parser.add_argument('--bundle', help='bundle dir for fetch-bundle (candidate sources + revision.json)')
    parser.add_argument('--revision', help='Full immutable SHA; omitted means check main')
    args = parser.parse_args()
    if args.command == 'fetch-bundle':
        if not args.bundle:
            raise ValueError('fetch-bundle requires --bundle DIR')
        revision = args.revision or latest_revision()
        report = fetch_bundle(revision, args.bundle)
        print(json.dumps({'revision': report['revision'], 'index_sha256': report['index_sha256']}))
        return
    current = verify_base(ROOT / VENDOR)
    if args.command == 'verify':
        if args.deployed:
            manifest = verify_deployed(args.deployed)
            print(f"Deployed checkout verified (local): {REPOSITORY}@{manifest['revision']} + home bridge")
        elif args.fetch:
            verify_fetched(ROOT / VENDOR)
            print(f"Source hashes verified (fetched): {REPOSITORY}@{current['revision']}")
        else:
            print(f"Source lock verified: {REPOSITORY}@{current['revision']}")
        return
    revision = args.revision or latest_revision()
    if not SHA.fullmatch(revision):
        raise ValueError('Invalid revision')
    changed = revision != current['revision']
    print(json.dumps({'current': current['revision'], 'candidate': revision, 'changed': changed}))
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a') as handle:
            handle.write(f'changed={str(changed).lower()}\nrevision={revision}\nprevious_revision={current["revision"]}\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        print(f'Upstream OpenBot check failed: {error}', file=sys.stderr)
        sys.exit(1)
