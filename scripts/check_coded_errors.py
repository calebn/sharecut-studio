#!/usr/bin/env python3
"""Ban uncoded refusals in services/ and util/registry*: raise a CodedError subclass instead.

A refusal that crosses a service boundary needs a code, a message written for the caller and a
fix, so every adapter (CLI, MCP, owner GUI, share guest) can project it the same way. A bare
``raise PermissionError`` or ``raise ValueError(...)`` carries no code: an owner MCP agent sees
a crash, and a guest sees a generic line. Use ``CodedValueError`` / ``CodedPermissionError`` from
``podcast_mcp.util.coded_error`` (see docs/contributing.md section Errors).

A ``ValueError`` inside a pydantic validator is allowed: pydantic turns it into a
``ValidationError`` before it reaches a boundary.
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "src" / "podcast_mcp"
BANNED = frozenset({"PermissionError", "ValueError"})
VALIDATOR_DECORATORS = frozenset(
    {"field_validator", "model_validator", "validator", "root_validator"}
)
ALLOWED: frozenset[tuple[str, str]] = frozenset()
"""Reviewed ``(posix path under src/podcast_mcp, enclosing function)`` pairs that may stay bare."""


def scoped_files() -> list[Path]:
    return sorted([*(PACKAGE / "services").rglob("*.py"), *(PACKAGE / "util").glob("registry*.py")])


def _decorator_name(node: ast.expr) -> str:
    target = node.func if isinstance(node, ast.Call) else node
    if isinstance(target, ast.Attribute):
        return target.attr
    return target.id if isinstance(target, ast.Name) else ""


def _raised_name(exc: ast.expr | None) -> str:
    if exc is None:
        return ""
    target = exc.func if isinstance(exc, ast.Call) else exc
    return target.id if isinstance(target, ast.Name) else ""


def violations(tree: ast.AST) -> Iterator[tuple[ast.Raise, str]]:
    """Each banned raise outside a pydantic validator, with its enclosing function name."""

    def walk(node: ast.AST, scope: str, in_validator: bool) -> Iterator[tuple[ast.Raise, str]]:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                validator = in_validator or any(
                    _decorator_name(d) in VALIDATOR_DECORATORS for d in child.decorator_list
                )
                yield from walk(child, child.name, validator)
                continue
            if (
                isinstance(child, ast.Raise)
                and not in_validator
                and _raised_name(child.exc) in BANNED
            ):
                yield child, scope
            yield from walk(child, scope, in_validator)

    yield from walk(tree, "<module>", False)


def check(paths: list[Path]) -> list[str]:
    problems: list[str] = []
    for path in paths:
        rel = path.relative_to(PACKAGE).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node, scope in violations(tree):
            if (rel, scope) in ALLOWED:
                continue
            name = _raised_name(node.exc)
            problems.append(
                f"{rel}:{node.lineno}: raise {name} in {scope}(): "
                f"raise Coded{name} with a code instead"
            )
    return problems


def main() -> int:
    problems = check(scoped_files())
    for line in problems:
        print(line, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
