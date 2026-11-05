"""The base branch comes from config/branches.json; `origin/main` is not hard-coded."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LITERAL = re.compile(r"origin/main|refs/(?:remotes/origin|heads)/main")
ALLOWED = {
    ".github/workflows/test.yml": "compatibility-base-ref defaults to the release branch",
    ".github/workflows/promote.yml": "the job runs only from the release branch",
    ".github/workflows/storybook.yml": "Pages deploys only from the release branch",
    ".github/workflows/release-desktop-build.yml": "releases are cut from main",
}
SCANNED = (
    "Makefile",
    "scripts/",
    ".github/workflows/",
    ".githooks/",
    "tests/test_project_writers_check.py",
    "tests/test_stage_spec_frozen.py",
    "tests/test_project_write_grant.py",
)


def tracked() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", *SCANNED], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return out.splitlines()


def test_no_script_makefile_or_gate_test_hard_codes_origin_main() -> None:
    offenders = [
        f"{path}:{number}: {line.strip()}"
        for path in tracked()
        if path not in ALLOWED
        for number, line in enumerate((ROOT / path).read_text().splitlines(), 1)
        if LITERAL.search(line) and not line.lstrip().startswith("group:")
    ]
    assert offenders == []


def test_allowlisted_files_still_need_their_literal() -> None:
    stale = [path for path in ALLOWED if not LITERAL.search((ROOT / path).read_text())]
    assert stale == []
