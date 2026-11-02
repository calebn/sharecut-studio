from __future__ import annotations

import re
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src/podcast_mcp"
_STORE_COMMIT = re.compile(r"\b_?store\.commit\(")
_SAVE_PROJECT = re.compile(r"\bsave_project\(")
_STORE_CTOR = re.compile(r"\bProjectStore\(")

# ProjectWorkspace is the committer. Undo/redo/goto no longer commit (HistoryManager.apply_*
# leave that to the workspace). session.py stays only through run_mutation until slice 4 moves it.
_COMMITTERS = {
    "project/history/session.py",
    "services/app/workspace.py",
}

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


def test_only_the_workspace_and_history_commit_through_the_store() -> None:
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
