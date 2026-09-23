"""CLI and MCP twins for record control."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.share_registry import reset_share_registry_for_tests
from podcast_mcp.mcp.tools.record import (
    record_pause_tool,
    record_resume_tool,
    record_start_tool,
    record_state_tool,
    record_stop_tool,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.record.reducer import RecordStateError
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.share import ShareService


def _isolate(tmp_workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_workspace / "shares_index.json"))
    monkeypatch.setenv("PODCAST_SHARE_REGISTRY", str(tmp_workspace / "reg.sqlite"))
    reset_share_registry_for_tests()
    reset_record_runtime_for_tests()


def _seed(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_record_cli_state_without_room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate(tmp_workspace, monkeypatch)
    _seed(minimal_project, sample_wav)
    runner = CliRunner()
    result = runner.invoke(cli_app, ["record", "state", "--project", str(minimal_project)])
    assert result.exit_code == 1
    assert "no active record room" in result.output


def test_record_cli_and_mcp_state_with_room(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate(tmp_workspace, monkeypatch)
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
    _isolate(tmp_workspace, monkeypatch)
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
    _isolate(tmp_workspace, monkeypatch)
    ws = _seed(minimal_project, sample_wav)
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
