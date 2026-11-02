from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src/podcast_mcp"
_STORE_COMMIT = re.compile(r"\b_?store\.commit\(")
_SAVE_PROJECT = re.compile(r"\bsave_project\(")
_STORE_CTOR = re.compile(r"\bProjectStore\(")

# ProjectWorkspace is the committer. Undo/redo/goto no longer commit (HistoryManager.apply_*
# leave that to the workspace), record_snapshot commits inline, and run_mutation commits
# through a callback the workspace hands it, so nothing under project/history commits itself.
_COMMITTERS = {"services/app/workspace.py"}

# Each of these still builds its own ProjectStore and moves in a later slice.
_STORE_CTOR_OUT_OF_SCOPE = {
    "project/io.py",
    "pipeline/steps.py",
    "services/record/service.py",
    "services/media/transcript_precorrect.py",
}


def _sources(pattern: re.Pattern[str]) -> set[str]:
    return {
        rel
        for path in _SRC.rglob("*.py")
        if pattern.search(path.read_text(encoding="utf-8"))
        and (rel := str(path.relative_to(_SRC))) != "project/store.py"
    }


def test_only_the_workspace_commits_through_the_store() -> None:
    assert _sources(_STORE_COMMIT) == _COMMITTERS


def test_only_the_store_calls_save_project() -> None:
    assert _sources(_SAVE_PROJECT) == {"models/episode.py"}


def test_only_the_workspace_constructs_the_store_for_history() -> None:
    assert _sources(_STORE_CTOR) == {"services/app/workspace.py"} | _STORE_CTOR_OUT_OF_SCOPE


def test_history_apply_moves_never_commit() -> None:
    import ast

    path = _SRC / "project/history/manager.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    bodies = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
        and (
            node.name.startswith("apply_")
            or node.name in {"_undo_locked", "_redo_locked", "_goto_locked"}
        )
    ]
    assert {b.name for b in bodies} >= {"apply_undo", "apply_redo", "apply_goto"}
    for body in bodies:
        calls = [
            n.func.attr
            for n in ast.walk(body)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
        ]
        assert "commit" not in calls, body.name


def _history_trees() -> list[tuple[Path, ast.Module]]:
    return [
        (path, ast.parse(path.read_text(encoding="utf-8")))
        for path in sorted((_SRC / "project/history").glob("*.py"))
    ]


def test_history_package_never_reaches_a_commit_attribute() -> None:
    for path, tree in _history_trees():
        attrs = [
            n.lineno for n in ast.walk(tree) if isinstance(n, ast.Attribute) and n.attr == "commit"
        ]
        assert attrs == [], f"{path.name}: .commit used at lines {attrs}"


def test_history_bare_commit_calls_use_a_keyword_only_commit_parameter() -> None:
    def check(node: ast.AST, enclosing: list[ast.FunctionDef | ast.AsyncFunctionDef]) -> list[int]:
        bad: list[int] = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            enclosing = [*enclosing, node]
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "commit"
        ) and not any("commit" in {a.arg for a in fn.args.kwonlyargs} for fn in enclosing):
            bad.append(node.lineno)
        for child in ast.iter_child_nodes(node):
            bad += check(child, enclosing)
        return bad

    seen = 0
    for path, tree in _history_trees():
        assert check(tree, []) == [], path.name
        seen += sum(
            1
            for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "commit"
        )
    assert seen >= 1  # session.py calls the callback


def test_run_mutation_commit_is_a_required_keyword_only_parameter() -> None:
    from podcast_mcp.project.history.session import run_mutation

    param = inspect.signature(run_mutation).parameters["commit"]
    assert param.kind is inspect.Parameter.KEYWORD_ONLY
    assert param.default is inspect.Parameter.empty
