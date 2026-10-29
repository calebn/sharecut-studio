"""The project entry file is `episode.sharecut`; its retired name must not creep back in."""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RETIRED = "episode.project" + ".json"

# Each entry names the retired file on purpose.
ALLOWED = frozenset(
    {
        "src/podcast_mcp/project/io.py",  # owns the name and renames it on open
        "docs/project-format.md",  # states the in-place rename and the fallback
        "tests/test_project_io.py",  # asserts the fallback text literally
        "gui/web/src/utils/projectFile.ts",  # mirrors the retired name for Home's rename copy
        "gui/web/src/stages/home/HomeScreen.test.tsx",  # asserts that copy literally
    }
)


def tracked_files(root: Path) -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True
    ).stdout
    return [name for name in listed.decode("utf-8").split("\0") if name]


def files_naming_the_retired_entry_file(root: Path, allowed: frozenset[str] = ALLOWED) -> list[str]:
    found = []
    for name in tracked_files(root):
        if name in allowed:
            continue
        path = root / name
        if path.is_symlink() or not path.is_file():
            continue
        if RETIRED.encode() in path.read_bytes():
            found.append(name)
    return found


def _git_repo(root: Path, files: dict[str, str]) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)


def test_a_tracked_file_naming_the_retired_entry_file_is_reported(tmp_path):
    _git_repo(
        tmp_path,
        {
            "docs/a.md": f"open {RETIRED} here",
            "docs/b.md": "open episode.sharecut here",
            "docs/project-format.md": f"was {RETIRED}",
            "schemas/episode.project.schema.json": "{}",
        },
    )

    assert files_naming_the_retired_entry_file(tmp_path) == ["docs/a.md"]


def test_an_untracked_file_is_not_scanned(tmp_path):
    _git_repo(tmp_path, {"kept.md": "ok"})
    (tmp_path / "scratch.md").write_text(RETIRED, encoding="utf-8")

    assert files_naming_the_retired_entry_file(tmp_path) == []


def test_the_repository_never_names_the_retired_entry_file_outside_the_allowlist():
    assert files_naming_the_retired_entry_file(REPO) == []
