"""Guard against committing machine-specific absolute home paths."""

from __future__ import annotations

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]

# Real home roots with a username segment, excluding intentional security-test
# sentinels (/Users/host/..., /Users/secret..., /Users/someone/...).
_HOME_PATH = re.compile(
    r"(?:/Users/(?!host(?:/|\"|')|secret(?:/|\"|')|someone(?:/|\"|'))"
    r"|/home/(?!host(?:/|\"|')|secret(?:/|\"|')|someone(?:/|\"|')))"
    r"[A-Za-z0-9._-]+/"
)

_SCAN_GLOBS = (
    "src/**/*.py",
    "tests/**/*.py",
    "scripts/**/*.py",
    "tests/fixtures/**/episode.project.json",
)


def test_repo_has_no_committed_user_home_paths() -> None:
    offenders: list[str] = []
    for pattern in _SCAN_GLOBS:
        for path in _REPO.glob(pattern):
            if not path.is_file() or path.name == "test_no_machine_paths.py":
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if "/Users/" not in text and "/home/" not in text:
                continue
            for i, line in enumerate(text.splitlines(), start=1):
                if "/Users/" not in line and "/home/" not in line:
                    continue
                # Assertions / docs that only mention the prefix as a forbidden pattern.
                if '"/Users/" not in' in line or "'/Users/' not in" in line:
                    continue
                if "hard-code" in line and "/Users/" in line:
                    continue
                if not _HOME_PATH.search(line):
                    continue
                offenders.append(f"{path.relative_to(_REPO)}:{i}:{line.strip()}")
    assert not offenders, "machine-specific home paths must not be committed:\n" + "\n".join(
        offenders
    )
