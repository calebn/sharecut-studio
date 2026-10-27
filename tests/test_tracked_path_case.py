"""No two git-tracked paths may differ only in case (breaks macOS/Windows checkouts)."""

from __future__ import annotations

import subprocess
from collections import defaultdict
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]


def _case_collisions(root: Path) -> list[list[str]]:
    """Groups of tracked paths that differ only in case.

    Paths are grouped by lowercased path *without* the final extension, so
    ``reviewQueue.ts`` vs ``ReviewQueue.tsx`` (extensionless imports resolve to
    the same file on case-insensitive checkouts) is caught. A same-case stem with
    different extensions (``foo.ts`` / ``foo.tsx``) is not a collision.
    """
    tracked = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split("\0")
    groups: dict[str, list[str]] = defaultdict(list)
    for path in filter(None, tracked):
        groups[str(PurePosixPath(path).with_suffix("")).lower()].append(path)
    collisions = []
    for paths in groups.values():
        stems = {str(PurePosixPath(p).with_suffix("")) for p in paths}
        if len(stems) > 1 or len({p.lower() for p in paths}) < len(paths):
            collisions.append(sorted(paths))
    return sorted(collisions)


def test_tracked_paths_do_not_collide_on_case_insensitive_filesystems() -> None:
    assert _case_collisions(ROOT) == [], (
        "These tracked paths differ only in case and collide on case-insensitive "
        "checkouts; rename one of each group (git mv)."
    )
