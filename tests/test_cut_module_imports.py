"""The cut modules form a DAG with every import at the top of the file (#1813)."""

from __future__ import annotations

import ast
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src"
_EDITS = _SRC / "podcast_mcp" / "edits"

# Modules whose function-level imports are all gone. decisions keeps a few (update_pending_edit
# calls up into cut_application, which imports decisions at the top); cut_application keeps one.
_NO_INLINE_IMPORTS = (
    "cut_effects",
    "cut_placement",
    "cut_policy",
    "cut_safety",
    "pause_floor",
    "range_edits",
    "range_target",
    "source_removals",
    "timeline_ops",
    "timeline_span",
    "transcript_cuts",
    "transcript_search",
    "tighten/apply",
    "tighten/candidate",
    "tighten/collect",
    "tighten/gate",
    "tighten/prepare",
    "tighten/propose",
)


def _module_name(path: Path) -> str:
    parts = path.relative_to(_SRC).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _top_level_imports(tree: ast.Module, known: set[str]) -> set[str]:
    found: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            if node.module in known:
                found.add(node.module)
            found.update(
                f"{node.module}.{a.name}" for a in node.names if f"{node.module}.{a.name}" in known
            )
        elif isinstance(node, ast.Import):
            found.update(a.name for a in node.names if a.name in known)
    return found


def test_edits_modules_import_each_other_without_a_cycle() -> None:
    paths = {_module_name(p): p for p in _EDITS.rglob("*.py")}
    graph = {
        name: _top_level_imports(ast.parse(path.read_text(encoding="utf-8")), set(paths)) - {name}
        for name, path in paths.items()
    }
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(name: str) -> list[str] | None:
        state[name] = 1
        stack.append(name)
        for dep in sorted(graph[name]):
            if state.get(dep) == 1:
                return [*stack[stack.index(dep) :], dep]
            if dep not in state and (cycle := visit(dep)):
                return cycle
        stack.pop()
        state[name] = 2
        return None

    for name in sorted(graph):
        if name not in state and (cycle := visit(name)):
            raise AssertionError("import cycle among edits modules: " + " -> ".join(cycle))


def test_cut_modules_have_no_function_level_imports() -> None:
    offenders: list[str] = []
    for rel in _NO_INLINE_IMPORTS:
        path = _EDITS / f"{rel}.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
                offenders.extend(
                    f"{rel}.py:{node.lineno}"
                    for node in ast.walk(fn)
                    if isinstance(node, ast.Import | ast.ImportFrom)
                )
    assert not offenders, "move these imports to the top of the file:\n" + "\n".join(
        sorted(set(offenders))
    )


_CUT_APPLICATION_LAZY = {"podcast_mcp.edits.transcript_cuts"}


def test_cut_application_keeps_only_the_transcript_cuts_import_lazy() -> None:
    # transcript_cuts imports cut_application at the top, so this one cannot move up yet.
    tree = ast.parse((_EDITS / "cut_application.py").read_text(encoding="utf-8"))
    lazy: set[str] = set()
    for fn in ast.walk(tree):
        if isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
            lazy.update(
                node.module or "" for node in ast.walk(fn) if isinstance(node, ast.ImportFrom)
            )
    assert lazy == _CUT_APPLICATION_LAZY
