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


def verify_deployed(deployed):
    """Verify a DEPLOYED checkout locally: pin, local hashes, applied patch.

    Unlike `verify --fetch` (remote files), this reads the operator's tree:
    HEAD must equal the pin, every lock file's LOCAL sha256 must match, the
    assembly seam must exist, and home-bridge.ts must be the applied patch
    (markers), not a stray file.
    """
    manifest = verify_base(ROOT / VENDOR)
    pin = manifest['revision']
    root = Path(deployed)
    if not (root / '.git').is_dir():
        raise ValueError(f'Deployed checkout is not a git tree: {deployed}')
    head = subprocess.run(
        ['git', '-C', str(root), 'rev-parse', 'HEAD'],
        capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    if head != pin:
        raise ValueError(f'Deployed HEAD {head} != pinned {pin}')
    for name in DEPLOYED_REQUIRED:
        if not (root / name).is_file():
            raise ValueError(f'Deployed checkout lacks required file: {name}')
    for name, want in manifest['files'].items():
        data = (root / name).read_bytes()
        if len(data) > LIMIT:
            raise ValueError(f'Deployed file exceeds size limit: {name}')
        if digest(data) != want:
            raise ValueError(f'Deployed file drift vs lock: {name}')
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
