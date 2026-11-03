"""One Restore operation on every surface: web document command, MCP tool and CLI (#3114)."""

from __future__ import annotations

import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.edit import edit_app
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import EditDecisionType, load_project, save_project
from podcast_mcp.project.store import history_index_path, history_snapshot_ids
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import EditService, HistoryService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate

SURFACES = ["web", "mcp", "cli"]


def _mute_workspace(root, name="p"):
    project = _project(root / name)
    mute = _cut("mute", 1, 2, reason="filler:um")
    mute.type = EditDecisionType.MUTE
    project.edit_decisions = [mute]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["mute"]) == 1
    return ws


def _ripple_workspace(root):
    project = _project(root / "ripple")
    project.edit_decisions = [_cut("cut", reason="filler:um")]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["cut"]) == 1
    return ws


def _restore(surface, ws, ids, *, dry_run=False):
    """RestoreResult JSON from one surface."""
    if surface == "web":
        with TestClient(create_app()) as client:
            reply = client.post(
                f"/api/document/command?path={quote(str(ws.path))}",
                json={
                    "type": "RestoreAppliedEdit",
                    "payload": {"ids": ids, "dry_run": dry_run},
                    "client_id": "parity",
                    "client_seq": 1,
                },
            )
        assert reply.status_code == 200, reply.text
        return reply.json()["command"]["payload"]["result"]
    if surface == "mcp":
        return json.loads(mcp_server.revert_applied_edit_tool(str(ws.path), ids, dry_run))
    args = ["restore-edit", "--project", str(ws.path), "--json"]
    for record_id in ids:
        args += ["--id", record_id]
    if dry_run:
        args.append("--dry-run")
    result = CliRunner().invoke(edit_app, args)
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


def _post_state(ws):
    project = load_project(ws.path)
    return json.dumps(
        {
            "clips": [c.model_dump(mode="json") for c in project.clips],
            "editorial": project.editorial.model_dump(mode="json"),
            "transcripts": project.transcript_data.model_dump(mode="json"),
            "duration": project.timeline.duration_sec,
        },
        sort_keys=True,
    )


def _disk_and_history(ws):
    index = history_index_path(ws.project)
    return ws.path.read_bytes(), index.read_bytes(), history_snapshot_ids(index)


def test_one_mute_record_restores_identically_on_web_mcp_and_cli(tmp_path):
    outcomes = {}
    for surface in SURFACES:
        ws = _mute_workspace(tmp_path, surface)
        record = ws.project.editorial.edit_log[0]
        assert record.inverse is not None and record.inverse.kind == "unmute"
        result = _restore(surface, ws, [record.id])
        outcomes[surface] = (
            json.dumps(result, sort_keys=True).replace(record.id, "REC"),
            _post_state(ws).replace(record.id, "REC"),
        )
    assert json.loads(outcomes["web"][0])["status"] == "restored"
    assert json.loads(outcomes["web"][1])["editorial"]["edit_log"] == []
    assert outcomes["mcp"] == outcomes["web"]
    assert outcomes["cli"] == outcomes["web"]


@pytest.mark.parametrize("surface", SURFACES)
def test_dry_run_writes_nothing_and_adds_no_history_step(tmp_path, surface):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    head = HistoryService(ws).status().head_id
    before = (_disk_and_history(ws), _post_state(ws))
    result = _restore(surface, ws, [record_id], dry_run=True)
    assert result["status"] == "planned"
    assert result["summary"]["ids"] == [record_id]
    assert (_disk_and_history(ws), _post_state(ws)) == before
    assert HistoryService(ws).status().head_id == head


def test_several_ids_restore_in_one_history_step(tmp_path):
    project = _project(tmp_path)
    first, second = _cut("m1", 1, 2, reason="filler:um"), _cut("m2", 3, 4, reason="filler:um")
    for mute in (first, second):
        mute.type = EditDecisionType.MUTE
    project.edit_decisions = [first, second]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["m1", "m2"]) == 2
    ids = [r.id for r in ws.project.editorial.edit_log]
    assert len(ids) == 2
    steps = len(history_snapshot_ids(history_index_path(ws.project)))
    result = EditService(ws).revert_applied(ids)
    assert result["status"] == "restored"
    assert result["summary"]["ids"] == ids
    assert len(history_snapshot_ids(history_index_path(ws.project))) == steps + 1
    assert load_project(ws.path).editorial.edit_log == []
    assert all(c.mute_regions == [] for c in load_project(ws.path).clips)


def test_unknown_id_is_a_conflict_that_writes_nothing(tmp_path):
    ws = _mute_workspace(tmp_path)
    before = (_disk_and_history(ws), _post_state(ws))
    result = EditService(ws).revert_applied(["alog_missing", ws.project.editorial.edit_log[0].id])
    assert result["status"] == "conflict"
    assert [(c["code"], c["record_id"]) for c in result["conflicts"]] == [
        ("applied_edit_not_found", "alog_missing")
    ]
    assert (_disk_and_history(ws), _post_state(ws)) == before


def test_cli_exits_2_on_conflict(tmp_path):
    ws = _mute_workspace(tmp_path)
    result = CliRunner().invoke(
        edit_app, ["restore-edit", "--project", str(ws.path), "--id", "alog_missing", "--json"]
    )
    assert result.exit_code == 2
    assert json.loads(result.stdout)["conflicts"][0]["code"] == "applied_edit_not_found"


def test_mute_reports_ready_and_ripple_reports_history_only(tmp_path):
    mute_ws = _mute_workspace(tmp_path)
    ripple_ws = _ripple_workspace(tmp_path)
    mute = EditService(mute_ws).list_applied_edits()["records"][0]
    ripple = EditService(ripple_ws).list_applied_edits()["records"][0]
    assert mute["restore"] == {"state": "ready", "code": None, "message": None, "blocked_by": []}
    assert ripple["restore"]["state"] == "history_only"
    assert ripple["inverse"] is None
    listed = CliRunner().invoke(edit_app, ["applied", "--project", str(ripple_ws.path), "--json"])
    assert listed.exit_code == 0
    assert json.loads(listed.stdout)["records"][0]["restore"]["state"] == "history_only"


def test_cli_exits_2_for_a_history_only_record(tmp_path):
    ws = _ripple_workspace(tmp_path)
    result = CliRunner().invoke(
        edit_app,
        ["restore-edit", "--project", str(ws.path), "--id", ws.project.editorial.edit_log[0].id],
    )
    assert result.exit_code == 2
    assert "History Undo" in result.output


def test_viewer_is_denied_on_web_mcp_and_cli(tmp_path, monkeypatch):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    viewer = capabilities_for_role("viewer")
    before = (_disk_and_history(ws), _post_state(ws))

    command = DocumentCommand(
        type="RestoreAppliedEdit",
        payload={"ids": [record_id], "dry_run": False},
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    with pytest.raises(PermissionError, match="RestoreAppliedEdit"):
        DocumentSyncService.open(ws.path).submit(command, capabilities=viewer)
    assert "guest_submit_document_command" not in tools_for_capabilities(viewer)

    def forbidden(*_args, **_kwargs):
        raise PermissionError("share capabilities do not allow document command")

    monkeypatch.setattr(
        "podcast_mcp.services.document_sync.submit_host_document_command", forbidden
    )
    result = CliRunner().invoke(
        edit_app, ["restore-edit", "--project", str(ws.path), "--id", record_id]
    )
    assert result.exit_code == 3
    assert (_disk_and_history(ws), _post_state(ws)) == before
