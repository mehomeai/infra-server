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


if __name__ == '__main__':
    unittest.main()
