"""History moves guarded by the head entry the caller saw (#1031 toast Undo)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.history.manager import StaleHistoryError
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import EditDecision, EditDecisionType, HistoryEntry
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_store import HISTORY_ENTRY_LIMIT, history_index_path, history_snapshot_path
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError

runner = CliRunner()


def _decision(decision_id: str, start: float) -> EditDecision:
    return EditDecision(
        id=decision_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=start + 0.5,
        reason="noise",
        applied=False,
    )


def _seed(project_path: Path) -> None:
    ws = ProjectWorkspace.open(project_path)
    ws.project.edit_decisions = [_decision("host-hit", 1.0)]
    ws.save()
    ws.record_snapshot("initial", force=True)


def _pad_history_to_cap(project_path: Path) -> None:
    """Fill history up to HISTORY_ENTRY_LIMIT with real snapshot files of the current state."""
    ws = ProjectWorkspace.open(project_path)
    with ws.transaction() as project:
        history = project.history
        index = history_index_path(project)
        current = history.entries[history.cursor]
        body = (project.workspace_path() / current.snapshot_file).read_text(encoding="utf-8")
        pad = []
        for i in range(HISTORY_ENTRY_LIMIT - len(history.entries)):
            entry_id = f"{i:012x}"
            path = history_snapshot_path(index, entry_id)
            path.write_text(body, encoding="utf-8")
            rel = path.relative_to(project.workspace_path()).as_posix()
            pad.append(HistoryEntry(id=entry_id, label=f"pad {i}", snapshot_file=rel))
        project.history = ProjectHistory(
            cursor=history.cursor + len(pad), entries=[*pad, *history.entries]
        )
        ws.save()


def _agent_edit(project_path: Path, decision_id: str = "agent-cut") -> None:
    ProjectWorkspace.open(project_path).mutate(
        "before agent cut",
        "after agent cut",
        lambda project: project.edit_decisions.append(_decision(decision_id, 4.0)),
    )


def _host_reject(svc: DocumentSyncService) -> dict:
    return svc.submit(
        DocumentCommand(
            type="RejectEdits",
            payload={"ids": ["host-hit"]},
            client_id="tab",
            role="viewer",
            client_seq=1,
        )
    )


def _undo(svc: DocumentSyncService, expected_head_id: str | None, seq: int = 2) -> dict:
    return svc.submit(
        DocumentCommand(
            type="UndoHistory",
            payload={"expected_head_id": expected_head_id},
            client_id="tab",
            role="viewer",
            client_seq=seq,
        )
    )


def _status(project_path: Path) -> dict:
    return HistoryService(ProjectWorkspace.open(project_path)).status()


def _decision_ids(project_path: Path) -> set[str]:
    return {e.id for e in ProjectWorkspace.open(project_path).project.edit_decisions}


def test_a_host_command_reply_names_the_history_entry_it_recorded(minimal_project):
    _seed(minimal_project)
    svc = DocumentSyncService.open(minimal_project)

    reply = _host_reject(svc)

    head = _status(minimal_project)["head_id"]
    assert reply["history_head_id"] == head
    assert svc.document_snapshot(projection="shell")["history"]["head_id"] == head


def test_toast_undo_at_the_history_cap_refuses_once_an_agent_edit_lands(minimal_project):
    _seed(minimal_project)
    _pad_history_to_cap(minimal_project)
    svc = DocumentSyncService.open(minimal_project)
    toast_entry = _host_reject(svc)["history_head_id"]
    cursor_after_host = _status(minimal_project)["cursor"]

    _agent_edit(minimal_project)

    after_agent = _status(minimal_project)
    assert cursor_after_host == after_agent["cursor"] == HISTORY_ENTRY_LIMIT - 1
    assert after_agent["head_id"] != toast_entry
    with pytest.raises(DocumentConflictError) as refused:
        _undo(svc, toast_entry)
    assert refused.value.code == "history_stale"
    assert "agent-cut" in _decision_ids(minimal_project)
    assert _status(minimal_project)["head_id"] == after_agent["head_id"]


def test_toast_undo_refuses_when_an_agent_edit_lands_before_the_click(minimal_project):
    _seed(minimal_project)
    svc = DocumentSyncService.open(minimal_project)
    toast_entry = _host_reject(svc)["history_head_id"]
    journal_head = svc.document_snapshot(projection="comments")["server_seq"]

    _agent_edit(minimal_project)

    with pytest.raises(DocumentConflictError) as refused:
        _undo(svc, toast_entry)
    assert refused.value.code == "history_stale"
    assert "agent-cut" in _decision_ids(minimal_project)
    assert svc.document_snapshot(projection="comments")["server_seq"] == journal_head


def test_toast_undo_reverts_its_own_change_while_it_is_still_the_head(minimal_project):
    _seed(minimal_project)
    svc = DocumentSyncService.open(minimal_project)
    toast_entry = _host_reject(svc)["history_head_id"]
    assert _decision_ids(minimal_project) == set()

    reply = _undo(svc, toast_entry)

    assert reply["ok"] is True
    assert _decision_ids(minimal_project) == {"host-hit"}


def test_a_stale_cmd_z_refuses_and_a_fresh_one_undoes_the_latest_change(minimal_project):
    _seed(minimal_project)
    svc = DocumentSyncService.open(minimal_project)
    _host_reject(svc)
    seen_by_tab = _status(minimal_project)["head_id"]

    _agent_edit(minimal_project)

    with pytest.raises(DocumentConflictError) as refused:
        _undo(svc, seen_by_tab)
    assert refused.value.code == "history_stale"
    assert "agent-cut" in _decision_ids(minimal_project)

    _undo(svc, _status(minimal_project)["head_id"], seq=3)
    assert "agent-cut" not in _decision_ids(minimal_project)


def test_a_stale_undo_over_http_is_a_coded_409(minimal_project):
    _seed(minimal_project)
    stale = _status(minimal_project)["head_id"]
    _agent_edit(minimal_project)

    response = TestClient(create_app()).post(
        "/api/document/command",
        params={"path": str(minimal_project)},
        json={
            "type": "UndoHistory",
            "payload": {"expected_head_id": stale},
            "client_id": "tab",
            "role": "viewer",
            "client_seq": 1,
        },
    )

    assert response.status_code == 409
    assert response.headers["X-Sharecut-Error-Code"] == "history_stale"
    assert response.json()["detail"]["conflict"] is True
    assert "agent-cut" in _decision_ids(minimal_project)


def test_redo_refuses_a_stale_expected_head(minimal_project):
    _seed(minimal_project)
    _agent_edit(minimal_project)
    _agent_edit(minimal_project, "second-agent-cut")
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()
    seen = _status(minimal_project)["head_id"]
    HistoryService(ProjectWorkspace.open(minimal_project)).undo()

    with pytest.raises(StaleHistoryError):
        HistoryService(ProjectWorkspace.open(minimal_project)).redo(expected_head_id=seen)
    assert _status(minimal_project)["head_id"] != seen


def test_mcp_undo_refuses_a_stale_expected_head_and_undoes_a_current_one(minimal_project):
    _seed(minimal_project)
    stale = _status(minimal_project)["head_id"]
    _agent_edit(minimal_project)

    with pytest.raises(StaleHistoryError):
        mcp_server.history_undo(str(minimal_project), expected_head_id=stale)
    assert "agent-cut" in _decision_ids(minimal_project)

    mcp_server.history_undo(
        str(minimal_project), expected_head_id=_status(minimal_project)["head_id"]
    )
    assert "agent-cut" not in _decision_ids(minimal_project)


@pytest.mark.asyncio
async def test_mcp_undo_tool_call_reports_history_stale(minimal_project):
    pytest.importorskip("mcp.client")
    from mcp.client import Client

    _seed(minimal_project)
    stale = _status(minimal_project)["head_id"]
    _agent_edit(minimal_project)

    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(
            "history_undo",
            {"project_path": str(minimal_project), "expected_head_id": stale},
        )

    assert result.is_error is True
    assert result.structured_content["error_code"] == "history_stale"
    assert "agent-cut" in _decision_ids(minimal_project)


def test_cli_undo_refuses_a_stale_expected_head_and_undoes_a_current_one(minimal_project):
    _seed(minimal_project)
    stale = _status(minimal_project)["head_id"]
    _agent_edit(minimal_project)

    refused = runner.invoke(
        app, ["undo", "--project", str(minimal_project), "--expected-head", stale]
    )
    assert refused.exit_code == 1
    assert "(code history_stale)" in refused.stderr
    assert "agent-cut" in _decision_ids(minimal_project)

    current = _status(minimal_project)["head_id"]
    undone = runner.invoke(
        app, ["undo", "--project", str(minimal_project), "--expected-head", current]
    )
    assert undone.exit_code == 0, undone.output
    assert "agent-cut" not in _decision_ids(minimal_project)
