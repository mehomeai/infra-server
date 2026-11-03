import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('upstream', Path(__file__).with_name('upstream.py'))
upstream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream)


class UpstreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.base = self.root / upstream.VENDOR
        self.base.mkdir(parents=True)
        self.sources = {name: f'synthetic source: {name}\n'.encode() for name in upstream.FILES}
        self.manifest = {
            'schema': 1, 'repository': upstream.REPOSITORY, 'branch': 'main',
            'revision': 'a' * 40,
            'files': {name: upstream.digest(data) for name, data in self.sources.items()},
        }
        upstream.write_snapshot(self.base, self.manifest, self.sources)

    def test_verify_and_detect_local_patch(self):
        upstream.verify_base(self.base)
        (self.base / 'LICENSE').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'Local drift'):
            upstream.verify_base(self.base)

    def test_reject_path_expansion_and_other_repository(self):
        for field, value in [('repository', 'other/repo'), ('files', {'../../outside': '0' * 64})]:
            manifest = copy.deepcopy(self.manifest)
            manifest[field] = value
            (self.base / 'upstream.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                upstream.manifest_at(self.base)

    def test_reject_branch_name_instead_of_immutable_revision(self):
        with self.assertRaisesRegex(ValueError, 'full lowercase'):
            upstream.refresh(self.root, 'main')

    def test_refuse_to_overwrite_local_changes_before_network_call(self):
        (self.base / 'LICENSE').write_text('local patch')
        calls = []
        with self.assertRaises(ValueError):
            upstream.refresh(self.root, 'b' * 40, lambda url: calls.append(url))
        self.assertEqual(calls, [])

    def test_failed_download_does_not_partially_update_snapshot(self):
        def fetch(url):
            if url.endswith('log.ts'):
                raise OSError('synthetic network failure')
            return b'new upstream content\n'
        with self.assertRaises(OSError):
            upstream.refresh(self.root, 'b' * 40, fetch)
        self.assertEqual(upstream.verify_base(self.base), self.manifest)

    def test_candidate_bundle_promotion_preserves_exact_source_bytes(self):
        candidate = Path(self.temp.name) / 'candidate'
        data = b'updated synthetic source\n'
        changed, manifest = upstream.refresh(self.root, 'b' * 40, lambda _url: data)
        self.assertTrue(changed)
        upstream.export_bundle(self.root, candidate)
        # Reconstruct the approved baseline to exercise the separate publishing job.
        upstream.write_snapshot(self.base, self.manifest, self.sources)
        upstream.promote_bundle(self.root, candidate)
        self.assertEqual(upstream.verify_base(self.base), manifest)
        self.assertEqual((self.base / 'apps/server/src/engine/worker.ts').read_bytes(), data)

    def test_publishing_rejects_extra_files_and_tampered_bundles(self):
        candidate = Path(self.temp.name) / 'candidate'
        upstream.export_bundle(self.root, candidate)
        extra = candidate / 'workflow.yml'
        extra.write_text('not permitted')
        with self.assertRaisesRegex(ValueError, 'unexpected'):
            upstream.promote_bundle(self.root, candidate)
        extra.unlink()
        (candidate / 'LICENSE').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'Local drift'):
            upstream.promote_bundle(self.root, candidate)
        self.assertEqual(upstream.verify_base(self.base), self.manifest)

    def test_publishing_rejects_symlinks(self):
        candidate = Path(self.temp.name) / 'candidate'
        upstream.export_bundle(self.root, candidate)
        license_path = candidate / 'LICENSE'
        license_path.unlink()
        license_path.symlink_to(self.base / 'LICENSE')
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            upstream.promote_bundle(self.root, candidate)


if __name__ == '__main__':
    unittest.main()
