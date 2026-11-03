#!/usr/bin/env python3
"""Verify/refresh a fixed, unpatched OpenMuse subset and prepare review bundles.

Only these paths may change. Downloads finish before the checkout is mutated.
Candidate code is tested in a separate read-only CI job from PR publishing.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VENDOR = Path('vendor/openmuse')
REPOSITORY = 'CopilotKit/openmuse'
FILES = ('LICENSE', 'apps/server/src/log.ts', 'apps/server/src/engine/worker.ts')
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')
LIMIT = 1024 * 1024


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
    manifest = manifest_at(base)
    for name in FILES:
        path = base / name
        if path.is_symlink() or any((base / p).is_symlink() for p in Path(name).parents):
            raise ValueError(f'Symlink in imported path: {name}')
        if digest(path.read_bytes()) != manifest['files'][name]:
            raise ValueError(f'Local drift or damaged source: {name}')
    return manifest


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'mehomeai-upstream-check/1'})
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Upstream response exceeds size limit')
    data.decode('utf-8')
    return data


def latest_revision(fetch=download):
    body = json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/commits/main'))
    revision = body.get('sha', '')
    if not SHA.fullmatch(revision):
        raise ValueError('GitHub did not return an immutable commit SHA')
    return revision


def write_snapshot(base, manifest, sources):
    for name, content in sources.items():
        path = base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (base / 'upstream.json').write_text(json.dumps(manifest, indent=2) + '\n')


def refresh(root, revision, fetch=download):
    current = verify_base(root / VENDOR)
    if not SHA.fullmatch(revision):
        raise ValueError('Supply a full lowercase commit SHA')
    if revision == current['revision']:
        return False, current
    sources = {name: fetch(f'https://raw.githubusercontent.com/{REPOSITORY}/{revision}/{name}')
               for name in FILES}
    # A large/binary response cannot become part of the text-only import.
    for content in sources.values():
        if len(content) > LIMIT:
            raise ValueError('Upstream source exceeds size limit')
        content.decode('utf-8')
    if not sources['LICENSE'].strip():
        raise ValueError('Upstream license is empty')
    updated = {**current, 'revision': revision,
               'files': {name: digest(content) for name, content in sources.items()}}
    write_snapshot(root / VENDOR, updated, sources)
    return True, updated


def export_bundle(root, destination):
    base = root / VENDOR
    manifest = verify_base(base)
    if destination.exists():
        raise ValueError('Bundle destination must not already exist')
    sources = {name: (base / name).read_bytes() for name in FILES}
    destination.mkdir(parents=True)
    write_snapshot(destination, manifest, sources)


def promote_bundle(root, source):
    verify_base(root / VENDOR)
    if source.is_symlink() or any(path.is_symlink() for path in source.rglob('*')):
        raise ValueError('Bundle must not contain symlinks')
    actual = {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()}
    if actual != set(FILES) | {'upstream.json'}:
        raise ValueError('Bundle contains unexpected or missing paths')
    manifest = verify_base(source)
    sources = {name: (source / name).read_bytes() for name in FILES}
    write_snapshot(root / VENDOR, manifest, sources)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['verify', 'check', 'update', 'promote'])
    parser.add_argument('--revision', help='Full immutable SHA; omitted means check main')
    parser.add_argument('--bundle', type=Path, help='Export directory, or input for promote')
    args = parser.parse_args()
    if args.command == 'promote':
        if not args.bundle:
            parser.error('promote requires --bundle')
        if args.revision and manifest_at(args.bundle)['revision'] != args.revision:
            raise ValueError('Bundle revision differs from the tested candidate')
        manifest = promote_bundle(ROOT, args.bundle)
        print(f"Promoted fixed-path candidate {manifest['revision']}")
        return
    current = verify_base(ROOT / VENDOR)
    if args.command == 'verify':
        print(f"Source hashes verified: {REPOSITORY}@{current['revision']}")
        return
    revision = args.revision or latest_revision()
    if not SHA.fullmatch(revision):
        raise ValueError('Invalid revision')
    changed = revision != current['revision']
    if args.command == 'update':
        changed, _ = refresh(ROOT, revision)
        if args.bundle and changed:
            export_bundle(ROOT, args.bundle)
    print(json.dumps({'current': current['revision'], 'candidate': revision, 'changed': changed}))
    if output := os.environ.get('GITHUB_OUTPUT'):
        with open(output, 'a') as handle:
            handle.write(f'changed={str(changed).lower()}\nrevision={revision}\nprevious_revision={current["revision"]}\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        print(f'Upstream check failed: {error}', file=sys.stderr)
        sys.exit(1)
