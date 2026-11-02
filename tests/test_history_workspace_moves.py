"""History moves: HistoryManager.apply_* change memory and the index, the workspace commits (#1849)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.project.history import HistoryManager
from podcast_mcp.project.history.manager import StaleHistoryError
from podcast_mcp.project.store import ProjectStore
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import CommentService, HistoryService


def _edited(path: Path) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(path)
    CommentService(ws).add(body="one", author="a", timeline_start=1.0)
    return ws


def test_apply_moves_leave_the_project_file_unchanged(minimal_project):
    ws = _edited(minimal_project)
    mgr = HistoryManager(ProjectStore(minimal_project))
    before = minimal_project.read_bytes()
    mgr.apply_undo(ws.project)
    assert ws.project.comments == []
    assert minimal_project.read_bytes() == before
    mgr.apply_redo(ws.project)
    assert len(ws.project.comments) == 1
    mgr.apply_goto(ws.project, 0)
    assert ws.project.comments == []
    assert minimal_project.read_bytes() == before


def test_workspace_moves_persist(minimal_project):
    ws = _edited(minimal_project)
    ws.undo()
    assert ProjectWorkspace.open(minimal_project).project.comments == []
    ws.redo()
    assert len(ProjectWorkspace.open(minimal_project).project.comments) == 1
    status = ws.goto(0)
    assert status.cursor == 0
    assert ProjectWorkspace.open(minimal_project).project.comments == []


def test_workspace_moves_inside_a_transaction_do_not_deadlock(minimal_project):
    ws = _edited(minimal_project)
    with ws.transaction():
        ws.undo()
    assert ProjectWorkspace.open(minimal_project).project.comments == []


@pytest.mark.parametrize("action", ["undo", "redo"])
def test_workspace_move_with_stale_head_leaves_the_file_untouched(minimal_project, action):
    ws = _edited(minimal_project)
    if action == "redo":
        ws.undo()
    before = minimal_project.read_bytes()
    with pytest.raises(StaleHistoryError):
        getattr(ws, action)(expected_head_id="not-the-head")
    assert minimal_project.read_bytes() == before
    good = ws.project.history.head_id()
    getattr(ws, action)(expected_head_id=good)
    assert minimal_project.read_bytes() != before


@pytest.mark.parametrize("action", ["undo", "redo", "goto"])
def test_history_service_move_commits_exactly_once(minimal_project, monkeypatch, action):
    ws = _edited(minimal_project)
    if action == "redo":
        ws.undo()
    calls: list[object] = []
    real = ProjectStore.commit

    def counting(self, project, *args, **kwargs):
        calls.append(project)
        return real(self, project, *args, **kwargs)

    monkeypatch.setattr(ProjectStore, "commit", counting)
    svc = HistoryService(ws)
    if action == "goto":
        svc.goto(0)
    else:
        getattr(svc, action)()
    assert len(calls) == 1
