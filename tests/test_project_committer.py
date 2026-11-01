from __future__ import annotations

import re
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src/podcast_mcp"
_STORE_COMMIT = re.compile(r"\b_?store\.commit\(")
_SAVE_PROJECT = re.compile(r"\bsave_project\(")
_STORE_CTOR = re.compile(r"\bProjectStore\(")

# ProjectWorkspace is the committer. The history modules commit the undo/redo and
# mutation entries through the store the workspace hands them; each shrinks when the
# history seam moves behind it.
_COMMITTERS = {
    "project/history/manager.py",
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
