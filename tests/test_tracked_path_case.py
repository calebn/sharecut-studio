"""No two git-tracked paths may differ only in case (breaks macOS/Windows checkouts)."""

from __future__ import annotations

import subprocess
from collections import defaultdict
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]


def _case_collisions(root: Path) -> list[list[str]]:
    """Tracked paths whose extensionless path or a parent directory differ only in case."""
    tracked = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split("\0")
    stems: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    dirs: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for path in filter(None, tracked):
        pure = PurePosixPath(path)
        stem = str(pure.with_suffix(""))
        stems[stem.lower()][stem].append(path)
        for parent in pure.parents:
            if str(parent) != ".":
                dirs[str(parent).lower()][str(parent)].append(path)
    collisions = set()
    for table in (stems, dirs):
        for spellings in table.values():
            paths = {p for group in spellings.values() for p in group}
            if len(spellings) > 1 or len(paths) > len(set(map(str.lower, paths))):
                collisions.add(tuple(sorted(paths)))
    return [list(group) for group in sorted(collisions)]


def test_tracked_paths_do_not_collide_on_case_insensitive_filesystems() -> None:
    assert _case_collisions(ROOT) == [], (
        "These tracked paths differ only in case and collide on case-insensitive "
        "checkouts; rename one of each group (git mv)."
    )
