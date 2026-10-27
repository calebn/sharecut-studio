"""No two git-tracked paths may collide on case-insensitive checkouts (macOS/Windows)."""

from __future__ import annotations

import subprocess
from collections import defaultdict
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
_IMPORTABLE = {"ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"}


def _case_collisions(root: Path) -> list[list[str]]:
    """Case-only path, directory and importable-module (foo.ts vs Foo.tsx) collisions."""
    raw = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"], check=True, capture_output=True
    ).stdout
    tracked = [p for p in raw.decode("utf-8", errors="surrogateescape").split("\0") if p]
    by_path: dict[str, set[str]] = defaultdict(set)
    dir_spellings: dict[str, set[str]] = defaultdict(set)
    dir_users: dict[str, set[str]] = defaultdict(set)
    modules: dict[tuple[str, str], dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for path in tracked:
        pure = PurePosixPath(path)
        by_path[path.lower()].add(path)
        for parent in pure.parents[:-1]:
            dir_spellings[str(parent).lower()].add(str(parent))
            dir_users[str(parent).lower()].add(path)
        name = pure.name.lower()
        ext = name.rsplit(".", 1)[-1] if "." in name else ""
        if ext in _IMPORTABLE:
            base = pure.name[: -len(ext) - 1]
            if base.lower().endswith(".d") and ext == "ts":
                base = base[:-2]
            modules[(str(pure.parent).lower(), base.lower())][base].add(path)
    found: set[tuple[str, ...]] = set()
    found.update(tuple(sorted(p)) for p in by_path.values() if len(p) > 1)
    for key, spellings in dir_spellings.items():
        if len(spellings) > 1:
            found.add(tuple(sorted(dir_users[key])))
        if key in by_path:
            found.add(tuple(sorted(by_path[key] | dir_users[key])))
    for bases in modules.values():
        if len(bases) > 1:
            found.add(tuple(sorted(p for paths in bases.values() for p in paths)))
    return [list(group) for group in sorted(found)]


def test_tracked_paths_do_not_collide_on_case_insensitive_filesystems() -> None:
    assert _case_collisions(ROOT) == [], (
        "These tracked paths differ only in case and collide on case-insensitive "
        "checkouts; rename one of each group (git mv)."
    )
