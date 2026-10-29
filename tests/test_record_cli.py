"""CLI and MCP twins for record control."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.mcp.tools.record import (
    record_marker_tool,
    record_pause_tool,
    record_resume_tool,
    record_room_tone_tool,
    record_start_tool,
    record_state_tool,
    record_stop_tool,
    record_target_tool,
)
from podcast_mcp.models import load_project, save_project
from podcast_mcp.models.episode import Track, TrackRole
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
from podcast_mcp.util.coded_error import CodedValueError


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
    refused = runner.invoke(cli_app, ["record", "start", "--project", str(minimal_project)])
    assert refused.exit_code == 1
    room = RecordSessionService(
        ws.project, session_id=RecordSessionService.active_session_id(ws.project)
    )
    room.join(
        token="",
        role="host",
        display_name="Host",
        client_id="record-join:host",
        connection_id="c0",
    )
    solo = runner.invoke(cli_app, ["record", "start", "--project", str(minimal_project)])
    assert solo.exit_code == 0, solo.output
    assert json.loads(record_state_tool(str(minimal_project)))["state"] == "recording"


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

    assert blockers() == ([{"code": "no_recorder"}], [{"code": "no_recorder"}])

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


def test_record_room_tone_cli_and_mcp_announce_a_round(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    _consented_room(ws)
    runner = CliRunner()
    host = RecordSessionService(
        ws.project, session_id=RecordSessionService.active_session_id(ws.project)
    )
    host.join(
        token="",
        role="host",
        display_name="Host",
        client_id="record-join:host",
        connection_id="c0",
    )
    first = runner.invoke(cli_app, ["record", "room-tone", "--project", str(minimal_project)])
    assert first.exit_code == 0, first.output
    payload = json.loads(first.output)
    assert payload["room_tone"]["round"] == 1
    assert payload["room_tone"]["duration_ms"] == 60_000
    assert 0 < payload["countdown_left_ms"] <= 60_000
    again = json.loads(record_room_tone_tool(str(minimal_project)))
    assert again["room_tone"]["round"] == 2
    assert json.loads(record_state_tool(str(minimal_project)))["room_tone"]["round"] == 2
    assert json.loads(record_start_tool(str(minimal_project)))["state"] == "recording"
    refused = runner.invoke(cli_app, ["record", "room-tone", "--project", str(minimal_project)])
    assert refused.exit_code == 1
    assert "Stop the take first" in refused.output
    with pytest.raises(RecordStateError):
        RecordControlService(ws).room_tone_countdown()


def test_record_host_commands_from_separate_processes_are_not_deduped(minimal_project, sample_wav):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    host = RecordSessionService(ws.project, session_id=room["session_id"])
    host.join(
        token="",
        role="host",
        display_name="Host",
        client_id="record-join:host",
        connection_id="c0",
    )
    script = (
        "import json, sys; "
        "from podcast_mcp.services.app import ProjectWorkspace; "
        "from podcast_mcp.services.record import RecordControlService; "
        "state = RecordControlService(ProjectWorkspace.open(sys.argv[1])).room_tone_countdown(); "
        "print(json.dumps(state['room_tone']['round']))"
    )
    rounds = []
    for _ in range(2):
        completed = subprocess.run(
            [sys.executable, "-c", script, str(minimal_project)],
            check=True,
            capture_output=True,
            text=True,
        )
        rounds.append(json.loads(completed.stdout))

    assert rounds == [1, 2]
    assert host.snapshot()["room_tone"]["round"] == 2


def test_record_room_tone_tool_is_registered() -> None:
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import record as record_tools

    mcp = MCPServer("t")
    record_tools.register(mcp)
    assert "record_room_tone_tool" in {t.name for t in mcp._tool_manager.list_tools()}


def test_record_target_cli_and_mcp_set_end_and_refuse_the_rest(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    _consented_room(ws)
    runner = CliRunner()
    done = runner.invoke(cli_app, ["record", "target", "end", "--project", str(minimal_project)])
    assert done.exit_code == 0, done.output
    assert json.loads(done.output)["target"] == {"kind": "end"}
    assert json.loads(record_target_tool(str(minimal_project)))["target"] == {"kind": "end"}
    started = runner.invoke(
        cli_app, ["record", "target", "start", "--project", str(minimal_project)]
    )
    assert started.exit_code == 0, started.output
    assert json.loads(started.output)["target"] == {"kind": "start"}
    for bare in ("insert", "replace"):
        needs_time = runner.invoke(
            cli_app, ["record", "target", bare, "--project", str(minimal_project)]
        )
        assert needs_time.exit_code == 1, needs_time.output
        assert f"the {bare} target needs a time" in needs_time.output
    bad = runner.invoke(cli_app, ["record", "target", "middle", "--project", str(minimal_project)])
    assert bad.exit_code == 1
    assert "invalid session target" in bad.output
    assert json.loads(record_state_tool(str(minimal_project)))["target"] == {"kind": "start"}


def test_record_target_cli_and_mcp_refuse_a_replace_over_an_unknown_track(
    minimal_project, sample_wav, tmp_workspace
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)

    def add_track(project) -> None:
        project.tracks.append(Track(id="ava", label="Ava", role=TrackRole.DIALOGUE))

    ws.mutate("seed", "seeded", add_track)
    _consented_room(ws)
    target = json.dumps({"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": ["ghost"]})
    refused = CliRunner().invoke(
        cli_app, ["record", "target", target, "--project", str(minimal_project)]
    )
    assert refused.exit_code == 1, refused.output
    assert "track_ids:" in refused.output and "ghost" in refused.output
    with pytest.raises(CodedValueError, match="track_ids:"):
        record_target_tool(str(minimal_project), target)
    assert json.loads(record_state_tool(str(minimal_project)))["target"] == {"kind": "end"}


def test_record_target_refused_once_a_take_exists(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    _consented_room(ws)
    host = RecordSessionService(
        ws.project, session_id=RecordSessionService.active_session_id(ws.project)
    )
    host.join(
        token="",
        role="host",
        display_name="Host",
        client_id="record-join:host",
        connection_id="c0",
    )
    assert json.loads(record_start_tool(str(minimal_project)))["state"] == "recording"
    runner = CliRunner()
    refused = runner.invoke(cli_app, ["record", "target", "end", "--project", str(minimal_project)])
    assert refused.exit_code == 1
    assert "locked once a take has been recorded" in refused.output


def test_record_target_tool_is_registered() -> None:
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import record as record_tools

    mcp = MCPServer("t")
    record_tools.register(mcp)
    assert "record_target_tool" in {t.name for t in mcp._tool_manager.list_tools()}
