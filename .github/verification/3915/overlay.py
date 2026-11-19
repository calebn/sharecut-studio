"""Copy only the fixed verifier inputs; never discover or execute other specs."""
from pathlib import Path
import shutil

SYNTHETIC = (
    'gui/web/e2e/scriptRecordingIdentityProject.ts',
    'gui/web/e2e/fixtures/script-recording-identity.sharecut',
)
OVERLAYS = {
    'independent-3915.spec.ts': 'e2e/independent-3915.spec.ts',
    'reporter.ts': 'e2e/independent3915-reporter.ts',
    'playwright.independent.config.ts': 'playwright.independent.config.ts',
    'run.ts': 'scripts/independent3915-run.ts',
}

def copy_checked(source: Path, destination: Path):
    # Parent predates the fixtures directory. Missing ancestors are expected.
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    if destination.read_bytes() != source.read_bytes():
        raise RuntimeError('BLOCKED')

def install_overlays(checkouts: Path, here: Path):
    for name in ('parent','head'):
        target=checkouts/name
        if name == 'parent':
            for rel in SYNTHETIC:
                copy_checked(checkouts/'head'/rel, target/rel)
        for source, relative in OVERLAYS.items():
            copy_checked(here/source, target/'gui/web'/relative)
