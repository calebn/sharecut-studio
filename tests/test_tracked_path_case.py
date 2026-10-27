"""No two git-tracked paths may collide on case-insensitive checkouts (macOS/Windows)."""

from __future__ import annotations

import itertools
import subprocess
from collections import defaultdict
from pathlib import Path, PurePosixPath

import pytest

ROOT = Path(__file__).resolve().parents[1]
_IMPORTABLE = {"ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"}


def _case_collisions(root: Path) -> list[list[str]]:
    """Case-only path, directory and importable-module (foo.ts vs Foo.tsx) collisions."""
    raw = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"], check=True, capture_output=True
    ).stdout
    tracked = [p for p in raw.decode("utf-8", errors="surrogateescape").split("\0") if p]
    return _collisions_among(tracked)


def _collisions_among(tracked: list[str]) -> list[list[str]]:
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


def _index_repo(root: Path, paths: list[str]) -> None:
    """Make a repo whose index holds `paths` (no working-tree files, so any filesystem works)."""
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    blob = (
        subprocess.run(
            ["git", "-C", str(root), "hash-object", "-w", "--stdin"],
            input=b"x",
            check=True,
            capture_output=True,
        )
        .stdout.decode()
        .strip()
    )
    for path in paths:
        subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "update-index",
                "--add",
                "--cacheinfo",
                f"100644,{blob},{path}",
            ],
            check=True,
        )


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        ([], []),
        (["a/b.ts", "c.py"], []),
        (
            ["src/ReviewQueue.tsx", "src/reviewQueue.ts"],
            [["src/ReviewQueue.tsx", "src/reviewQueue.ts"]],
        ),
        (["foo.ts", "foo.tsx"], []),
        (["README.md", "readme.txt"], []),
        (["Foo.TXT", "foo.txt"], [["Foo.TXT", "foo.txt"]]),
        (["docs/a.md", "Docs/b.md"], [["Docs/b.md", "docs/a.md"]]),
        (["docs", "Docs/x.md"], [["Docs/x.md", "docs"]]),
        (["a/Foo.js", "a/foo.jsx"], [["a/Foo.js", "a/foo.jsx"]]),
        (["a/Foo.mjs", "a/foo.cjs"], [["a/Foo.mjs", "a/foo.cjs"]]),
        (["a/Foo.mts", "a/foo.cts"], [["a/Foo.mts", "a/foo.cts"]]),
        (["a/Foo.TSX", "a/foo.ts"], [["a/Foo.TSX", "a/foo.ts"]]),
        (["a/foo.d.js", "a/Foo.js"], []),
        (["a/Foo.D.ts", "a/foo.ts"], [["a/Foo.D.ts", "a/foo.ts"]]),
        (["a/X.ts", "a/x.tsx"], [["a/X.ts", "a/x.tsx"]]),
        (["a/\udcff.md"], []),
        (["a/bd.ts", "a/BD.tsx"], [["a/BD.tsx", "a/bd.ts"]]),
        (["a/ts", "a/Ts.tsx"], []),
        (
            ["A/Foo.ts", "a/foo.tsx", "A/z.md"],
            [["A/Foo.ts", "A/z.md", "a/foo.tsx"], ["A/Foo.ts", "a/foo.tsx"]],
        ),
        (["docs", "Docs/sub/x.md"], [["Docs/sub/x.md", "docs"]]),
        (["A/x/f.md", "a/y/g.md"], [["A/x/f.md", "a/y/g.md"]]),
        (["a/B/x.md", "a/b/y.md"], [["a/B/x.md", "a/b/y.md"]]),
        (["a/docs", "a/Docs/x.md"], [["a/Docs/x.md", "a/docs"]]),
        (["a/b/Foo.ts", "a/b/foo.tsx"], [["a/b/Foo.ts", "a/b/foo.tsx"]]),
        (["a/b/Foo.TXT", "a/b/foo.txt"], [["a/b/Foo.TXT", "a/b/foo.txt"]]),
        (["a/b/foo.ts", "a/b/foo.tsx"], []),
        (["a/b/C/x.md", "a/b/c/y.md"], [["a/b/C/x.md", "a/b/c/y.md"]]),
        (["a/b/docs", "a/b/Docs/x.md"], [["a/b/Docs/x.md", "a/b/docs"]]),
        (["a/b/c/Foo.ts", "a/b/c/foo.tsx"], [["a/b/c/Foo.ts", "a/b/c/foo.tsx"]]),
        (["a/b/c/Foo.TXT", "a/b/c/foo.txt"], [["a/b/c/Foo.TXT", "a/b/c/foo.txt"]]),
        (["a/b/c/foo.ts", "a/b/c/foo.tsx"], []),
        (["foo.d.ts", "Foo.ts"], [["Foo.ts", "foo.d.ts"]]),
        (["docs", "Docs/a/b/c.md"], [["Docs/a/b/c.md", "docs"]]),
        (["a/foo.ts", "b/Foo.tsx"], []),
        (["a/Foo.ts", "a/foo.css"], []),
        (["a/Foo.tsx", "a/foo.css"], []),
    ],
)
def test_case_collisions_scenarios(
    tmp_path: Path, files: list[str], expected: list[list[str]]
) -> None:
    _index_repo(tmp_path, files)
    assert _case_collisions(tmp_path) == expected


def _module_base(path: str) -> tuple[str, str] | None:
    """(directory, base name) of an importable file, else None; `x.d.ts` counts as `x.ts`."""
    directory, _, name = path.rpartition("/")
    for ext in ("ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"):
        if name.lower().endswith("." + ext) and len(name) > len(ext) + 1:
            base = name[: -len(ext) - 1]
            if ext == "ts" and base.lower().endswith(".d"):
                base = base[:-2]
            return directory, base
    return None


def _dirs(path: str) -> list[str]:
    parts = path.split("/")
    return ["/".join(parts[:i]) for i in range(1, len(parts))]


def _oracle_collide(p: str, q: str) -> bool:
    if p != q and p.lower() == q.lower():
        return True
    for x, y in ((p, q), (q, p)):
        if any(d.lower() == o.lower() and d != o for d in _dirs(x) for o in [*_dirs(y), y]):
            return True
    mp, mq = _module_base(p), _module_base(q)
    return bool(mp and mq and mp[0] == mq[0] and mp[1] != mq[1] and mp[1].lower() == mq[1].lower())


_VOCAB = [
    "a/Foo.ts", "a/foo.tsx", "a/foo.ts", "a/Foo.tsx", "b/Foo.tsx", "A/x.md", "a/x.md",
    "docs", "Docs/a/b/c.md", "a/foo.css", "a/Foo.TXT", "a/foo.txt", "README.md",
    "readme.txt", "a/foo.d.ts", "a/Foo.d.ts", "a/Foo.TSX", "a/Foo.D.ts", "a/bd.ts",
    "a/BD.tsx", "a/foo.d.js", "a/Foo.js", "a/b/Foo.js", "a/b/foo.jsx",
]  # fmt: skip


def test_guard_flags_same_files_as_naive_oracle() -> None:
    for size in (1, 2, 3):
        for files in itertools.combinations(_VOCAB, size):
            expected = {p for p, q in itertools.permutations(files, 2) if _oracle_collide(p, q)}
            flagged = {p for group in _collisions_among(list(files)) for p in group}
            assert flagged == expected, files
