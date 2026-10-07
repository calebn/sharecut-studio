"""CLI and MCP twins for record control."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.mcp.tools.record import (
    record_marker_tool,
    record_pause_tool,
    record_resume_tool,
    record_start_tool,
    record_state_tool,
    record_stop_tool,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.record.live_comments import live_comment_store_for
from podcast_mcp.services.record.reducer import RecordStateError
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    reset_record_runtime_for_tests,
)


def _isolate() -> None:
    reset_record_runtime_for_tests()


def _seed(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _consented_room(ws) -> None:
    """Open a record room whose one guest has consented, so the host can start."""
    room = ShareService(ws).create_record_room()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-guest",
        connection_id="c1",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": 2,
        },
        client_id="rec-guest",
        role="guest",
        participant_id=echo["participant_id"],
        seq=2,
        capabilities=["join", "monitor"],
        connection_id="c1",
    )


def test_record_cli_state_without_room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    _seed(minimal_project, sample_wav)
    runner = CliRunner()
    result = runner.invoke(cli_app, ["record", "state", "--project", str(minimal_project)])
    assert result.exit_code == 1
    assert "no active record room" in result.output


def test_record_cli_and_mcp_state_with_room(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    ShareService(ws).create_record_room()
    runner = CliRunner()
    result = runner.invoke(cli_app, ["record", "state", "--project", str(minimal_project)])
    assert result.exit_code == 0
    assert "lobby" in result.output
    roster = runner.invoke(cli_app, ["record", "roster", "--project", str(minimal_project)])
    assert roster.exit_code == 0
    payload = json.loads(record_state_tool(str(minimal_project)))
    assert payload["available"] is True
    blocked = runner.invoke(cli_app, ["record", "start", "--project", str(minimal_project)])
    assert blocked.exit_code == 1
    assert json.loads(record_state_tool(str(minimal_project)))["available"] is True


def test_record_mcp_state_without_room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    _seed(minimal_project, sample_wav)
    payload = json.loads(record_state_tool(str(minimal_project)))
    assert payload["available"] is False
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import record as record_tools

    mcp = MCPServer("t")
    record_tools.register(mcp)
    names = {t.name for t in mcp._tool_manager.list_tools()}
    assert "record_start_tool" in names
    assert "record_stop_tool" in names


def test_record_cli_and_mcp_transport_after_consent(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    _consented_room(ws)
    runner = CliRunner()
    started = runner.invoke(cli_app, ["record", "start", "--project", str(minimal_project)])
    assert started.exit_code == 0, started.output
    assert "recording" in started.output
    paused = runner.invoke(cli_app, ["record", "pause", "--project", str(minimal_project)])
    assert paused.exit_code == 0
    resumed = runner.invoke(cli_app, ["record", "resume", "--project", str(minimal_project)])
    assert resumed.exit_code == 0
    stopped = runner.invoke(cli_app, ["record", "stop", "--project", str(minimal_project)])
    assert stopped.exit_code == 0
    assert json.loads(record_start_tool(str(minimal_project)))["state"] == "recording"
    assert json.loads(record_pause_tool(str(minimal_project)))["state"] == "paused"
    assert json.loads(record_resume_tool(str(minimal_project)))["state"] == "recording"
    assert json.loads(record_stop_tool(str(minimal_project)))["state"] == "stopped"
    ctrl = RecordControlService(ws)
    with pytest.raises(RecordStateError):
        ctrl.pause()


def test_record_state_reaches_agents_with_coded_start_blockers(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app())

    def blockers() -> tuple[list, list]:
        via_mcp = json.loads(record_state_tool(str(minimal_project)))["start_blockers"]
        via_http = client.get("/api/record/state", params={"path": str(minimal_project)}).json()[
            "start_blockers"
        ]
        return via_mcp, via_http

    assert blockers() == ([{"code": "no_guest"}], [{"code": "no_guest"}])

    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-guest",
        connection_id="c1",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    pending = [
        {
            "code": "consent_pending",
            "participant_id": echo["participant_id"],
            "display_name": "Ava",
        }
    ]
    assert blockers() == (pending, pending)


def test_record_marker_cli_and_mcp_stamp_the_open_take(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    _consented_room(ws)
    runner = CliRunner()
    args = ["--project", str(minimal_project)]
    refused = runner.invoke(cli_app, ["record", "marker", *args])
    assert refused.exit_code == 1
    assert "cannot comment" in refused.output
    assert runner.invoke(cli_app, ["record", "start", *args]).exit_code == 0
    marked = runner.invoke(cli_app, ["record", "marker", *args, "--body", "Retake intro"])
    assert marked.exit_code == 0, marked.output
    tool_marker = json.loads(record_marker_tool(str(minimal_project)))
    session_id = RecordSessionService.active_session_id(ws.project)
    rows = live_comment_store_for(ws.project).list_unlanded(session_id)
    assert sorted(r["body"] for r in rows) == ["Marker", "Retake intro"]
    assert tool_marker["marker_id"] in {r["comment_id"] for r in rows}
    assert {r["take_index"] for r in rows} == {0}
