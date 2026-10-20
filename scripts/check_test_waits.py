#!/usr/bin/env python3
"""Fail on a new fixed wait in the tests (D5, #1446): wait on an event or a state, not on time.

A ``time.sleep``, ``asyncio.sleep`` or ``waitForTimeout`` in ``tests/`` or ``gui/web/e2e*`` makes a
test slower than it needs to be on a fast machine and flaky on a slow one. The waits that exist
today are listed per file in ``contracts/test-wait-allowlist.json``. The list is a ratchet: a file
may not gain a wait, a file that is not listed may not have one, and a file that lost waits must
lower its count, so the list only shrinks. ``--write`` regenerates it after a fix.

Python files are read with ``ast``, so a comment or a string that says ``time.sleep`` does not
count. A TypeScript line counts when it calls ``waitForTimeout(`` outside a ``//`` or ``/* */`` comment
(a ``//`` right after a colon, as in ``http://``, is not a comment).
"""

from __future__ import annotations

import ast
import json
import re
import sys
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST = ROOT / "contracts" / "test-wait-allowlist.json"
PY_ROOTS = ("tests",)
TS_ROOTS = ("gui/web/e2e", "gui/web/e2e-compat", "gui/web/e2e-storybook")
TS_SUFFIXES = frozenset({".ts", ".tsx", ".js", ".mjs"})
SLEEP_MODULES = frozenset({"time", "asyncio"})
TS_WAIT = re.compile(r"\bwaitForTimeout\s*\(")
TS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/")
TS_LINE_COMMENT = re.compile(r"(?<!:)//.*")


def python_waits(path: Path) -> list[int]:
    """Line numbers of ``time.sleep(...)`` and ``asyncio.sleep(...)`` calls in ``path``."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    bare: set[str] = set()
    modules: set[str] = set(SLEEP_MODULES)
    calls: list[ast.Call] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in SLEEP_MODULES:
            bare.update(a.asname or a.name for a in node.names if a.name == "sleep")
        elif isinstance(node, ast.Import):
            modules.update(a.asname for a in node.names if a.asname and a.name in SLEEP_MODULES)
        elif isinstance(node, ast.Call):
            calls.append(node)
    lines: list[int] = []
    for node in calls:
        func = node.func
        module_sleep = (
            isinstance(func, ast.Attribute)
            and func.attr == "sleep"
            and isinstance(func.value, ast.Name)
            and func.value.id in modules
        )
        if module_sleep or (isinstance(func, ast.Name) and func.id in bare):
            lines.append(node.lineno)
    return sorted(lines)


def typescript_waits(path: Path) -> list[int]:
    """Line numbers of ``waitForTimeout(...)`` calls that are not inside a ``//`` comment."""
    lines: list[int] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        code = TS_LINE_COMMENT.sub("", TS_BLOCK_COMMENT.sub("", line))
        if TS_WAIT.search(code):
            lines.append(number)
    return lines


def scan(root: Path = ROOT) -> dict[str, int]:
    """Count the fixed waits per file, keyed by posix path under ``root``."""
    counts: dict[str, int] = {}
    for rel in PY_ROOTS:
        for path in sorted((root / rel).rglob("*.py")):
            if found := python_waits(path):
                counts[path.relative_to(root).as_posix()] = len(found)
    for rel in TS_ROOTS:
        base = root / rel
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.suffix not in TS_SUFFIXES or "node_modules" in path.parts:
                continue
            if found := typescript_waits(path):
                counts[path.relative_to(root).as_posix()] = len(found)
    return counts


def load_allowlist(path: Path = ALLOWLIST) -> dict[str, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {str(k): int(v) for k, v in data["files"].items()}


def problems(counts: dict[str, int], allowed: dict[str, int]) -> Iterator[str]:
    """One message per file whose count differs from its allowance."""
    for rel in sorted(counts.keys() | allowed.keys()):
        found, limit = counts.get(rel, 0), allowed.get(rel, 0)
        if found > limit:
            yield (
                f"{rel}: {found} fixed wait(s), {limit} allowed. Wait on an event or a state "
                "(poll a condition, await the signal, use a locator assertion), not on time."
            )
        elif found < limit:
            yield (
                f"{rel}: {found} fixed wait(s) left, {limit} allowed. "
                "Run scripts/check_test_waits.py --write to lower the allowlist."
            )


def write_allowlist(counts: dict[str, int], path: Path = ALLOWLIST) -> None:
    payload = {
        "api_version": 1,
        "comment": (
            "Fixed waits (time.sleep, asyncio.sleep, waitForTimeout) the tests still hold, per "
            "file. A ratchet: counts may only go down. Regenerate with "
            "scripts/check_test_waits.py --write."
        ),
        "files": dict(sorted(counts.items())),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    counts = scan()
    if "--write" in args:
        write_allowlist(counts)
        print(
            f"wrote {ALLOWLIST.relative_to(ROOT)}: {sum(counts.values())} waits in {len(counts)} files"
        )
        return 0
    found = list(problems(counts, load_allowlist()))
    for message in found:
        print(message, file=sys.stderr)
    if found:
        print(
            "Tests never wait on time (docs/testing.md § Tests never wait on time).",
            file=sys.stderr,
        )
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
