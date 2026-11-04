import copy
import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('upstream_openbot', Path(__file__).with_name('upstream-openbot.py'))
upstream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream)


class UpstreamOpenBotTests(unittest.TestCase):
    def manifest(self, revision='a' * 40, files=None):
        data = {name: f'synthetic openbot source: {name}\n'.encode() for name in upstream.FILES}
        if files is not None:
            data = files
        return {
            'schema': 1, 'repository': upstream.REPOSITORY, 'branch': 'main',
            'revision': revision,
            'files': {name: upstream.digest(content) for name, content in data.items()},
        }, data

    def test_verify_lock_format(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            manifest, _ = self.manifest()
            (base / 'upstream.json').write_text(json.dumps(manifest))
            self.assertEqual(upstream.verify_base(base), manifest)

    def test_reject_branch_name_instead_of_immutable_revision(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            manifest, _ = self.manifest(revision='main')
            (base / 'upstream.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'immutable full commit'):
                upstream.verify_base(base)

    def test_reject_path_expansion_and_other_repository(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            manifest, _ = self.manifest()
            for field, value in [('repository', 'other/repo'), ('files', {'../../outside': '0' * 64})]:
                bad = copy.deepcopy(manifest)
                bad[field] = value
                (base / 'upstream.json').write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    upstream.manifest_at(base)

    def test_reject_symlink_manifest(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            real = Path(tmp) / 'real.json'
            manifest, _ = self.manifest()
            real.write_text(json.dumps(manifest))
            (base / 'upstream.json').symlink_to(real)
            with self.assertRaisesRegex(ValueError, 'regular file'):
                upstream.manifest_at(base)

    def test_verify_fetched_detects_drift(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            manifest, data = self.manifest(revision='b' * 40)
            (base / 'upstream.json').write_text(json.dumps(manifest))
            # Exact fetch passes.
            got = upstream.verify_fetched(base, lambda url: data[url.rsplit('/', 1)[-1]] if False else next(
                content for name, content in data.items() if url.endswith(name)))
            self.assertEqual(got['revision'], 'b' * 40)
            # Tampered fetch fails naming the file.
            tampered = dict(data)
            tampered['LICENSE'] = b'tampered'
            def fetch(url):
                for name, content in tampered.items():
                    if url.endswith(name):
                        return content
                raise AssertionError(url)
            with self.assertRaisesRegex(ValueError, 'LICENSE'):
                upstream.verify_fetched(base, fetch)

    def test_fetch_bundle_records_digests_and_seam(self):
        import tempfile
        manifest, data = self.manifest()
        data['server/src/index.ts'] = b'candidate index content\n'
        def fetch(url):
            name = url.rsplit('/', 1)[-1]
            if url.endswith('server/src/index.ts'):
                return data['server/src/index.ts']
            for key, content in data.items():
                if url.endswith(key):
                    return content
            raise AssertionError(url)
        with tempfile.TemporaryDirectory() as tmp:
            report = upstream.fetch_bundle('c' * 40, tmp, fetch)
            self.assertEqual(report['revision'], 'c' * 40)
            self.assertEqual(report['index_sha256'], upstream.digest(data['server/src/index.ts']))
            for name in upstream.FILES:
                self.assertTrue((Path(tmp) / name).is_file())
                self.assertEqual(report['files'][name], upstream.digest(data[name]))
            self.assertTrue((Path(tmp) / 'revision.json').is_file())
            self.assertTrue((Path(tmp) / 'server/src/index.ts').is_file())
        with self.assertRaises(ValueError):
            upstream.fetch_bundle('main', tmp, fetch)

    def test_production_lock_matches_allowlist(self):
        repo = Path(__file__).resolve().parents[1]
        manifest = upstream.verify_base(repo / upstream.VENDOR)
        self.assertEqual(manifest['revision'], '6bfee780c8e8d05141375ea55ebde33eefb3dbc0')
        self.assertEqual(set(manifest['files']), set(upstream.FILES))

    def test_deployed_refuses_pin_drift(self):
        import subprocess
        import tempfile
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            subprocess.run(['git', '-C', tmp, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], check=True)
            with self.assertRaisesRegex(ValueError, '!= pinned'):
                upstream.verify_deployed(tmp)

    def _deployed_fixture(self, tmp):
        """Synthetic deployed checkout + vendor base with a patch manifest.

        Base tree: every lock file at ORIGINAL bytes, committed; HEAD then
        becomes the lock revision. The patch footprint is applied as
        uncommitted changes (index.ts + config.ts modified, home-bridge.ts
        new), exactly like apply.sh leaves a real checkout. The vendor
        base carries upstream.json + patches/{manifest.json, 0001-test.patch}
        whose post-hashes pin the patched bytes.
        """
        import subprocess
        root = Path(tmp) / 'checkout'
        vendor = Path(tmp) / 'vendorbase'
        (vendor / 'patches').mkdir(parents=True)
        root.mkdir()
        contents = {name: f'base source: {name}\n'.encode() for name in upstream.FILES}
        index_original = b'index base\n'
        bridge = b'wrapAuthWithHomeBridge ME_HOME_BRIDGE_SECRET timingSafeEqual\n'
        contents['server/src/index.ts'] = index_original
        for name, data in contents.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_bytes(data)
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        subprocess.run(['git', '-C', str(root), 'add', '-A'], check=True)
        subprocess.run(['git', '-C', str(root), '-c', 'user.email=t@t', '-c', 'user.name=t',
                        'commit', '-q', '-m', 'base'], check=True)
        head = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'],
                              capture_output=True, text=True, check=True).stdout.strip()
        lock = {'schema': 1, 'repository': upstream.REPOSITORY, 'branch': 'main',
                'revision': head,
                'files': {name: upstream.digest(data)
                          for name, data in contents.items() if name in upstream.FILES}}
        (vendor / 'upstream.json').write_text(json.dumps(lock))
        index_post = index_original + b'wrapAuthWithHomeBridge(homeAuth\n'
        config_post = contents['server/src/config.ts'] + b'// patched\n'
        (root / 'server/src/index.ts').write_bytes(index_post)
        (root / 'server/src/config.ts').write_bytes(config_post)
        (root / 'server/src/home-bridge.ts').write_bytes(bridge)
        patch_bytes = b'synthetic patch\n'
        (vendor / 'patches' / '0001-test.patch').write_bytes(patch_bytes)
        patch_manifest = {
            'schema': 1, 'repository': upstream.REPOSITORY, 'baseCommit': head,
            'patch': '0001-test.patch', 'patchSha256': upstream.digest(patch_bytes),
            'files': {
                'server/src/config.ts': {
                    'originalSha256': upstream.digest(contents['server/src/config.ts']),
                    'postSha256': upstream.digest(config_post)},
                'server/src/index.ts': {
                    'originalSha256': upstream.digest(index_original),
                    'postSha256': upstream.digest(index_post)},
                'server/src/home-bridge.ts': {
                    'originalSha256': None,
                    'postSha256': upstream.digest(bridge)},
            },
            'unmodified': {'server/src/app.ts': upstream.digest(contents['server/src/app.ts'])},
        }
        (vendor / 'patches' / 'manifest.json').write_text(json.dumps(patch_manifest))
        return root, vendor, contents

    def test_deployed_correct_post_patch_state_passes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root, vendor, _ = self._deployed_fixture(tmp)
            got = upstream.verify_deployed(root, vendor)
            self.assertEqual(got['repository'], upstream.REPOSITORY)
            self.assertEqual(set(got['files']), set(upstream.FILES))

    def test_deployed_missing_patch_manifest_fails(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root, vendor, _ = self._deployed_fixture(tmp)
            (vendor / 'patches' / 'manifest.json').unlink()
            with self.assertRaisesRegex(ValueError, 'Patch manifest missing'):
                upstream.verify_deployed(root, vendor)

    def test_deployed_tampered_patch_file_fails(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root, vendor, _ = self._deployed_fixture(tmp)
            (vendor / 'patches' / '0001-test.patch').write_bytes(b'tampered patch\n')
            with self.assertRaisesRegex(ValueError, 'tampered'):
                upstream.verify_deployed(root, vendor)

    def test_deployed_tampered_post_patch_file_fails(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root, vendor, _ = self._deployed_fixture(tmp)
            (root / 'server/src/config.ts').write_bytes(b'tampered post-patch bytes\n')
            with self.assertRaisesRegex(ValueError, 'post-patch drift vs patch manifest'):
                upstream.verify_deployed(root, vendor)

    def test_deployed_unpatched_seam_file_fails(self):
        # The seam exception pins POST-patch bytes: a config.ts still at
        # its lock (original) hash is an unpatched deployment, not a pass.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root, vendor, contents = self._deployed_fixture(tmp)
            (root / 'server/src/config.ts').write_bytes(contents['server/src/config.ts'])
            with self.assertRaisesRegex(ValueError, 'post-patch drift vs patch manifest'):
                upstream.verify_deployed(root, vendor)

    def test_deployed_unmodified_drift_fails(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root, vendor, _ = self._deployed_fixture(tmp)
            (root / 'server/src/app.ts').write_bytes(b'drifted\n')
            with self.assertRaisesRegex(ValueError, 'drift'):
                upstream.verify_deployed(root, vendor)

    def test_deployed_unapproved_tracked_drift_fails(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root, vendor, _ = self._deployed_fixture(tmp)
            (root / 'server/src/copilot.ts').write_bytes(b'changed outside the seam\n')
            with self.assertRaisesRegex(ValueError, 'Unexpected tracked drift'):
                upstream.verify_deployed(root, vendor)

    def test_deployed_requires_patch_markers(self):
        import subprocess
        import tempfile
        real = upstream.verify_base(Path(__file__).resolve().parents[1] / upstream.VENDOR)
        _ = real
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            for name in upstream.DEPLOYED_REQUIRED:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text('placeholder')
            (root / 'server/src/home-bridge.ts').write_text('no markers here')
            subprocess.run(['git', '-C', tmp, 'add', '-A'], check=True)
            subprocess.run(['git', '-C', tmp, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], check=True)
            # Pin check fires first on a synthetic tree (honest: HEAD != pin).
            with self.assertRaises(ValueError):
                upstream.verify_deployed(tmp)


class ApplyScriptPathTests(unittest.TestCase):
    """Regression: apply.sh must canonicalize HERE to an absolute path.

    Its documented invocation is relative (`sh vendor/openbot/patches/
    apply.sh`), and `git -C "$DIR" apply` resolves patch paths INSIDE the
    checkout — a relative "$HERE"/0001-*.patch therefore never resolves
    and the documented invocation fails. The real script refuses to run
    against a synthetic checkout (its PIN is the real upstream commit),
    so the fixture copies the script verbatim except that the pin hex
    (PIN= and the embedded manifest check) is pointed at the fixture's
    own HEAD; every other byte, including the HERE canonicalization,
    is the production script.
    """

    def _fixture(self, tmp):
        import hashlib
        import subprocess
        root = Path(tmp)
        checkout = root / 'checkout'
        (checkout / 'server' / 'src').mkdir(parents=True)
        originals = {
            'server/src/index.ts': 'index base\n',
            'server/src/config.ts': 'config base\n',
            'server/src/app.ts': 'app base\n',
        }
        for name, text in originals.items():
            (checkout / name).write_text(text)
        subprocess.run(['git', 'init', '-q', str(checkout)], check=True)
        subprocess.run(['git', '-C', str(checkout), 'add', '-A'], check=True)
        subprocess.run(['git', '-C', str(checkout), '-c', 'user.email=t@t',
                        '-c', 'user.name=t', 'commit', '-q', '-m', 'base'],
                       check=True)
        head = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'],
                              capture_output=True, text=True,
                              check=True).stdout.strip()
        # A patch in the real footprint shape: modify index.ts + config.ts,
        # add home-bridge.ts carrying the markers apply.sh greps for.
        post_index = 'index base\nwrapAuthWithHomeBridge(homeAuth)\n'
        post_config = 'config base\n// meHomeBridgeConfigured(environment)\n'
        bridge = ('export const wrapAuthWithHomeBridge = 1;\n'
                  'export const bridgeSessionCache = 2;\n'
                  'export const ME_HOME_BRIDGE_SECRET = 3;\n')
        work = root / 'work'
        (work / 'server' / 'src').mkdir(parents=True)
        for name, text in originals.items():
            (work / name).write_text(text)
        subprocess.run(['git', 'init', '-q', str(work)], check=True)
        subprocess.run(['git', '-C', str(work), 'add', '-A'], check=True)
        subprocess.run(['git', '-C', str(work), '-c', 'user.email=t@t',
                        '-c', 'user.name=t', 'commit', '-q', '-m', 'base'],
                       check=True)
        (work / 'server/src/index.ts').write_text(post_index)
        (work / 'server/src/config.ts').write_text(post_config)
        (work / 'server/src/home-bridge.ts').write_text(bridge)
        subprocess.run(['git', '-C', str(work), 'add', '-A'], check=True)
        patch = subprocess.run(['git', '-C', str(work), 'diff', '--cached'],
                               capture_output=True, text=True,
                               check=True).stdout
        patches = root / 'patches'
        patches.mkdir()
        (patches / '0001-test.patch').write_text(patch)
        sha = lambda b: hashlib.sha256(b).hexdigest()
        manifest = {
            'baseCommit': head,
            'patch': '0001-test.patch',
            'patchSha256': sha(patch.encode()),
            'files': {
                'server/src/index.ts': {
                    'originalSha256': sha(originals['server/src/index.ts'].encode()),
                    'postSha256': sha(post_index.encode())},
                'server/src/config.ts': {
                    'originalSha256': sha(originals['server/src/config.ts'].encode()),
                    'postSha256': sha(post_config.encode())},
                'server/src/home-bridge.ts': {
                    'originalSha256': None,
                    'postSha256': sha(bridge.encode())},
            },
            'unmodified': {
                'server/src/app.ts': sha(originals['server/src/app.ts'].encode())},
        }
        (patches / 'manifest.json').write_text(json.dumps(manifest))
        real = (Path(__file__).resolve().parents[1]
                / 'vendor' / 'openbot' / 'patches' / 'apply.sh').read_text()
        # The pin hex appears twice (PIN= and the manifest baseCommit
        # check in the embedded python); retarget BOTH to the fixture HEAD.
        pin_hex = '6bfee780c8e8d05141375ea55ebde33eefb3dbc0'
        self.assertGreaterEqual(real.count(pin_hex), 2)
        (patches / 'apply.sh').write_text(real.replace(pin_hex, head))
        return checkout, patches

    def test_apply_sh_documented_relative_invocation(self):
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            checkout, patches = self._fixture(tmp)
            # Exactly the documented shape: relative script path, relative
            # patches dir, invoked from an unrelated cwd.
            proc = subprocess.run(
                ['sh', 'patches/apply.sh'],
                cwd=tmp, capture_output=True, text=True,
                env={'PATH': '/usr/bin:/bin:/usr/local/bin',
                     'OPENBOT_CHECKOUT': str(checkout)})
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
            self.assertIn('apply.sh: applied: 0001-test.patch', proc.stdout)
            self.assertIn('apply.sh: OK', proc.stdout)
            self.assertTrue((checkout / 'server/src/home-bridge.ts').is_file())


if __name__ == '__main__':
    unittest.main()
