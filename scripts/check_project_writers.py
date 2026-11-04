#!/usr/bin/env python3
"""Ratchet the direct project writers listed in contracts/project-writers.json.

A project file should change through the document dispatcher in
``services/document_sync``. This script counts the writers that still skip it and fails
when a new one appears or when a listed row is stale or over-counted, so the list can
only shrink.

The scan is a name heuristic over the AST, not type analysis. It cannot know a
receiver's type, so a workspace write is a call to ``mutate``, ``save``, ``save_merged``
or ``record_snapshot`` on a receiver whose last name is ``ws``, ``workspace``, ``_ws`` or
``_workspace`` (``self.ws`` and ``self._ws`` included), and a store write is ``commit`` on
a receiver ending in ``store``. A service method that writes behind a read-and-write
class, such as ``EpisodeService(ws).set_track_meta``, is invisible here; the runtime
guard planned for ``ProjectStore.commit`` will cover those; only the live project file is in scope, not history sidecars or relocated copies. Everything under
``services/document_sync`` is the dispatcher itself and is not counted.

Primitives:
  apply_external_document_edit  CLI wrapper that marks a legacy edit as external
  notify_after_mutation         MCP tools wrapped by the legacy post-write notifier,
                                counted as the ``mutating`` set minus its ``discard`` calls
  ws.mutate, ws.save, ws.save_merged, ws.record_snapshot, _store.commit
  CommentService.write          comment writes called directly on ``CommentService(...)``
                                or on a name bound to it in the same function

``--census`` prints the current rows as JSON for seeding or reviewing the contract.
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from collections import Counter
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = ROOT / "src" / "podcast_mcp"
DEFAULT_CONTRACT = ROOT / "contracts" / "project-writers.json"

DOOR = "services/document_sync/"
EXTERNAL_EDIT = "apply_external_document_edit"
NOTIFY = "notify_after_mutation"
COMMENT_WRITE = "CommentService.write"
WORKSPACE_RECEIVERS = frozenset({"ws", "workspace", "_ws", "_workspace"})
WORKSPACE_WRITES = frozenset({"mutate", "save", "save_merged", "record_snapshot"})
COMMENT_WRITES = frozenset(
    {"add", "update", "resolve", "delete", "set_action_done", "add_action", "add_reply"}
)

Key = tuple[str, str]


def _last_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_comment_service(node: ast.expr) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "CommentService"
    )


def _comment_aliases(scope: ast.AST) -> set[str]:
    aliases: set[str] = set()
    for node in ast.walk(scope):
        if isinstance(node, ast.Assign) and _is_comment_service(node.value):
            aliases.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return aliases


def _primitive(call: ast.Call, aliases: set[str]) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return EXTERNAL_EDIT if func.id == EXTERNAL_EDIT else None
    if not isinstance(func, ast.Attribute):
        return None
    if func.attr == EXTERNAL_EDIT:
        return EXTERNAL_EDIT
    receiver = _last_name(func.value)
    if func.attr in WORKSPACE_WRITES and receiver in WORKSPACE_RECEIVERS:
        return f"ws.{func.attr}"
    if func.attr == "commit" and receiver is not None and receiver.endswith("store"):
        return "_store.commit"
    if func.attr in COMMENT_WRITES and (
        _is_comment_service(func.value)
        or (isinstance(func.value, ast.Name) and func.value.id in aliases)
    ):
        return COMMENT_WRITE
    return None


def _wrapped_tools(scope: ast.FunctionDef | ast.AsyncFunctionDef) -> int | None:
    """Net size of the ``mutating`` set in a function that wraps tools with the notifier."""
    members: set[str] = set()
    found = False
    for node in ast.walk(scope):
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "mutating" for t in node.targets)
            and isinstance(node.value, ast.Set)
        ):
            found = True
            members |= {n for e in node.value.elts if (n := _last_name(e))}
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "discard"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "mutating"
            and node.args
            and (name := _last_name(node.args[0]))
        ):
            members.discard(name)
    return len(members) if found else None


def _uses_notifier(scope: ast.AST) -> bool:
    return any(isinstance(n, ast.Call) and _last_name(n.func) == NOTIFY for n in ast.walk(scope))


def _scan_module(tree: ast.Module) -> Counter[str]:
    found: Counter[str] = Counter()
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and _uses_notifier(stmt):
            tools = _wrapped_tools(stmt)
            found[NOTIFY] += tools if tools is not None else 1
    aliases = _comment_aliases(tree)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and (primitive := _primitive(node, aliases)):
            found[primitive] += 1
    return found


def scan(src: Path) -> dict[Key, int]:
    """Count writers per (module, primitive) under ``src``, skipping the dispatcher."""
    counts: dict[Key, int] = {}
    for path in sorted(src.rglob("*.py")):
        module = path.relative_to(src).as_posix()
        if module.startswith(DOOR):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for primitive, count in _scan_module(tree).items():
            counts[(module, primitive)] = count
    return counts


def validate_rows(rows: Sequence[dict[str, Any]]) -> list[str]:
    problems: list[str] = []
    keys: list[Key] = []
    for row in rows:
        key = (str(row.get("module")), str(row.get("primitive")))
        label = f"{key[0]} {key[1]}"
        if set(row) != {"module", "primitive", "count", "reason"}:
            problems.append(f"{label}: row keys must be module, primitive, count, reason")
        count = row.get("count")
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            problems.append(f"{label}: count must be an integer of at least 1")
        reason = row.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            problems.append(f"{label}: reason must say why the writer is still direct")
        keys.append(key)
    for key, n in Counter(keys).items():
        if n > 1:
            problems.append(f"{key[0]} {key[1]}: duplicate row")
    if keys != sorted(keys):
        problems.append("rows must be sorted by module then primitive")
    return problems


def compare(rows: Sequence[dict[str, Any]], actual: dict[Key, int]) -> list[str]:
    """List every disagreement between the contract rows and the scanned writers."""
    listed = {(r["module"], r["primitive"]): r["count"] for r in rows}
    problems: list[str] = []
    for key in sorted(listed.keys() | actual.keys()):
        want, got = listed.get(key), actual.get(key, 0)
        label = f"{key[0]} {key[1]}"
        if want is None:
            problems.append(
                f"{label}: {got} found, not listed; route the write through "
                "the document dispatcher instead of adding a row"
            )
        elif got == 0:
            problems.append(f"{label}: listed {want}, found 0; delete the row")
        elif got > want:
            problems.append(
                f"{label}: listed {want}, found {got}; a new writer must use the document dispatcher"
            )
        elif got < want:
            problems.append(f"{label}: listed {want}, found {got}; lower the count to {got}")
    return problems


def grown(base: Sequence[dict[str, Any]], rows: Sequence[dict[str, Any]]) -> list[str]:
    """List every row that is new or has a higher count than in the base contract."""
    before = {(r["module"], r["primitive"]): r["count"] for r in base}
    problems: list[str] = []
    for row in rows:
        key = (row["module"], row["primitive"])
        if key not in before:
            problems.append(f"{key[0]} {key[1]}: new row; the list can only shrink")
        elif row["count"] > before[key]:
            problems.append(
                f"{key[0]} {key[1]}: count grew from {before[key]} to {row['count']}; "
                "the list can only shrink"
            )
    return problems


def load_rows(text: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    rows = data.get("writers") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ValueError('the contract must be a JSON object with a "writers" list')
    return rows


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=ROOT, check=False, capture_output=True, text=True)


def base_rows(ref: str, contract: Path) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Return the base contract rows, or ``(None, None)`` when that ref has no contract yet.

    A ref that does not resolve, or a base file that cannot be parsed, is an error message.
    """
    if (
        ref.startswith("-")
        or _git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode
    ):
        return None, f"--base {ref} is not a commit in this checkout"
    rel = contract.resolve().relative_to(ROOT).as_posix()
    shown = _git("show", f"{ref}:{rel}")
    if shown.returncode:
        return None, None
    try:
        return load_rows(shown.stdout), None
    except ValueError as exc:
        return None, f"{ref}:{rel}: {exc}"


def census(actual: dict[Key, int]) -> list[dict[str, Any]]:
    return [
        {"module": m, "primitive": p, "count": n, "reason": ""}
        for (m, p), n in sorted(actual.items())
    ]


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC)
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument(
        "--base",
        metavar="REF",
        help="git ref whose contract the rows may not grow beyond (an unresolvable ref fails; a ref without the file skips the check)",
    )
    parser.add_argument("--census", action="store_true", help="print current writers as JSON rows")
    args = parser.parse_args(list(argv) if argv is not None else None)
    actual = scan(args.src)
    if args.census:
        print(json.dumps(census(actual), indent=2))
        return 0
    try:
        rows = load_rows(args.contract.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"project-writers: {args.contract}: {exc}", file=sys.stderr)
        return 1
    problems = validate_rows(rows) + compare(rows, actual)
    if args.base:
        base, error = base_rows(args.base, args.contract)
        if error:
            problems.append(error)
        elif base is None:
            print(f"project-writers: {args.base} has no contract yet; growth check skipped")
        else:
            problems += grown(base, rows)
    for problem in problems:
        print(f"project-writers: {problem}", file=sys.stderr)
    if problems:
        print(
            "project-writers: the list can only shrink; see docs/contributing.md",
            file=sys.stderr,
        )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
