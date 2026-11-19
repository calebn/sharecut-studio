import tempfile
import unittest
from pathlib import Path
from overlay import SYNTHETIC, OVERLAYS, install_overlays

class OverlaySetup(unittest.TestCase):
    def setUp(self):
        self.scratch=tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root=Path(self.scratch.name)
        self.checkouts=self.root/'checkouts'
        self.here=self.root/'input'; self.here.mkdir()
        for rel in SYNTHETIC:
            f=self.checkouts/'head'/rel; f.parent.mkdir(parents=True,exist_ok=True)
            f.write_bytes(('synthetic:'+rel).encode())
        for file in OVERLAYS: (self.here/file).write_bytes(('overlay:'+file).encode())
    def test_missing_parent_fixture_and_script_directories(self):
        self.assertFalse((self.checkouts/'parent').exists())
        install_overlays(self.checkouts,self.here)
        for rel in SYNTHETIC:
            self.assertEqual((self.checkouts/'parent'/rel).read_bytes(),(self.checkouts/'head'/rel).read_bytes())
        for name in ('parent','head'):
            for src,dst in OVERLAYS.items():
                self.assertEqual((self.checkouts/name/'gui/web'/dst).read_bytes(),(self.here/src).read_bytes())
    def test_no_unlisted_spec_copied(self):
        (self.here/'unlisted.spec.ts').write_text('not authorized')
        install_overlays(self.checkouts,self.here)
        self.assertFalse(list(self.checkouts.rglob('unlisted.spec.ts')))
    def test_missing_source_fails_closed(self):
        (self.here/'reporter.ts').unlink()
        with self.assertRaises(FileNotFoundError): install_overlays(self.checkouts,self.here)
    def test_non_directory_ancestor_fails_closed(self):
        parent=self.checkouts/'parent'; parent.mkdir()
        (parent/'gui').write_text('not a directory')
        with self.assertRaises(OSError): install_overlays(self.checkouts,self.here)

if __name__=='__main__': unittest.main()
