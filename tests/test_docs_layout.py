"""Per-issue evidence stays on the pull request, not in the docs tree."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_ISSUE_EVIDENCE = re.compile(r"^docs/issue-\d+/")


def _tracked_issue_evidence(root: Path) -> list[str]:
    tracked = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "docs"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split("\0")
    return [path for path in tracked if _ISSUE_EVIDENCE.match(path)]


def test_docs_track_no_per_issue_evidence_folders() -> None:
    assert _tracked_issue_evidence(ROOT) == [], (
        "Post issue screenshots and receipts in the PR description or a PR comment; "
        "do not commit docs/issue-<n>/ folders (docs/contributing.md § Review evidence)."
    )


def test_tracked_issue_folder_is_reported(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "docs" / "issue-42").mkdir(parents=True)
    (tmp_path / "docs" / "issue-42" / "README.md").write_text("evidence\n")
    (tmp_path / "docs" / "issue-tracking.md").write_text("guide\n")
    subprocess.run(["git", "-C", str(tmp_path), "add", "docs"], check=True)

    assert _tracked_issue_evidence(tmp_path) == ["docs/issue-42/README.md"]
