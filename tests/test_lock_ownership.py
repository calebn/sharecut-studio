"""``util/file_locks.py`` is the only place that builds a ``FileLock`` or calls ``flock``."""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
OWNER = Path("podcast_mcp/util/file_locks.py")


def lock_primitive_uses(root: Path, owner: Path = OWNER) -> list[str]:
    """``file:line what`` for every ``FileLock(...)`` call and ``flock`` use outside ``owner``."""
    found: list[str] = []
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root)
        if rel == owner:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            what = _primitive(node)
            if what is not None:
                found.append(f"{rel.as_posix()}:{getattr(node, 'lineno', 0)} {what}")
    return found


def _primitive(node: ast.AST) -> str | None:
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Name) and func.id == "FileLock":
            return "FileLock("
        if isinstance(func, ast.Attribute) and func.attr == "FileLock":
            return "FileLock("
        if isinstance(func, ast.Attribute) and func.attr == "flock":
            return "flock("
    if (
        isinstance(node, ast.ImportFrom)
        and node.module == "fcntl"
        and any(alias.name == "flock" for alias in node.names)
    ):
        return "from fcntl import flock"
    return None


def test_only_file_locks_builds_locks() -> None:
    assert lock_primitive_uses(SRC) == []


def test_ownership_scan_catches_a_violation(tmp_path: Path) -> None:
    owner = tmp_path / OWNER
    owner.parent.mkdir(parents=True)
    owner.write_text("from filelock import FileLock\nlock = FileLock('a')\n", encoding="utf-8")
    sabotage = tmp_path / "podcast_mcp" / "services" / "sneaky.py"
    sabotage.parent.mkdir(parents=True)
    sabotage.write_text(
        "import fcntl\nfrom filelock import FileLock\n"
        "def f(fd):\n    fcntl.flock(fd, fcntl.LOCK_EX)\n    return FileLock('x')\n",
        encoding="utf-8",
    )
    assert lock_primitive_uses(tmp_path) == [
        "podcast_mcp/services/sneaky.py:4 flock(",
        "podcast_mcp/services/sneaky.py:5 FileLock(",
    ]
