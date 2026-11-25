"""Pins the strip_silence reply, CLI stdout, clips and journal across service, handler, tool, CLI."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import click
import pytest
from pydantic import BaseModel
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import load_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import AnalysisService, StripSilenceResult
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.handlers.edits import strip_silence as handler
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.util.coded_error import CodedError, CodedValueError
from test_strip_silence_tool_journal import _bare_path
from test_strip_silence_tool_pin import _config as _config
from test_strip_silence_tool_pin import _entries, _history, _journal, _path

runner = CliRunner()

SILENCES = (
    '{\n  "track_id": "host",\n  "silence_intervals": 2,\n  "clips_created": 3,\n'
    '  "removed_sec": 2.8000000000000007,\n  "timeline_duration_sec": 3.1999999999999993\n}'
)
SILENCES_WITH_GUEST = SILENCES.replace("3.1999999999999993", "6.0")
NO_SILENCE = (
    '{\n  "track_id": "host",\n  "silence_intervals": 0,\n  "clips_created": 1,\n'
    '  "removed_sec": 0.0,\n  "timeline_duration_sec": 6.0\n}'
)
NO_CONTRAST = (
    '{\n  "track_id": "guest",\n  "silence_intervals": 0,\n  "clips_created": 1,\n'
    '  "removed_sec": 0.0,\n  "timeline_duration_sec": 6.0\n}'
)
KEYS = [
    "track_id",
    "silence_intervals",
    "clips_created",
    "removed_sec",
    "timeline_duration_sec",
]
ISLANDS = [
    (0.0, 1.05, 0.0, 0, 10),
    (2.45, 3.55, 1.05, 10, 10),
    (4.95, 6.0, 2.15, 10, 10),
]


def _clips(path: str, track_id: str = "host") -> list[tuple]:
    clips = sorted(
        (c for c in load_project(Path(path)).clips if c.track_id == track_id),
        key=lambda c: c.timeline_start,
    )
    return [
        (
            round(c.source_start, 6),
            round(c.source_end, 6),
            round(c.timeline_start, 6),
            c.fade_in_ms,
            c.fade_out_ms,
            c.join_in_mode.value,
        )
        for c in clips
    ]


def _islands(path: str) -> None:
    assert _clips(path) == [(*row, "fade") for row in ISLANDS]


def _service(path: str, **kwargs) -> StripSilenceResult:
    ws = ProjectWorkspace.open(Path(path))
    with write_grant(WriteGrantKind.LEGACY_CLI), ws.transaction():
        return AnalysisService(ws).strip_silence(**kwargs)


def _handler(path: str, **kwargs) -> dict:
    ws = ProjectWorkspace.open(Path(path))
    payload = validate_payload("StripSilence", kwargs)
    with write_grant(WriteGrantKind.LEGACY_CLI), ws.transaction():
        return handler(ws, payload)


def _tool(path: str, **kwargs) -> str:
    return mcp_timeline.strip_silence_tool(path, **kwargs)


def _cli(path: str, *args: str):
    return runner.invoke(app, ["edit", "strip-silence", "--project", path, *args])


def _out(result) -> str:
    return click.unstyle(result.stdout)


def _err(result) -> str:
    return click.unstyle(result.stderr)


def _text(reply: dict | BaseModel) -> str:
    dumped = reply.model_dump() if isinstance(reply, BaseModel) else reply
    return json.dumps(dumped, indent=2)


def test_service_returns_the_typed_result(tmp_path):
    path = _path(tmp_path)
    reply = _service(path, track_id="host")
    assert type(reply) is StripSilenceResult
    assert list(StripSilenceResult.model_fields) == KEYS
    assert _text(reply) == SILENCES
    _islands(path)


def test_handler_returns_the_same_dict(tmp_path):
    path = _path(tmp_path)
    reply = _handler(path, track_id="host")
    assert type(reply) is dict
    assert list(reply) == KEYS
    assert _text(reply) == SILENCES
    _islands(path)


def test_tool_reply_is_the_exact_json_text(tmp_path):
    path = _path(tmp_path)
    assert _tool(path, track_id="host") == SILENCES
    _islands(path)


def test_cli_stdout_is_the_exact_json_text(tmp_path):
    path = _path(tmp_path)
    result = _cli(path, "--track", "host")
    assert result.exit_code == 0
    assert result.stdout == SILENCES + "\n"
    assert result.stderr == ""
    _islands(path)


def test_the_rebuilt_clips_have_micro_fades_and_fresh_ids(tmp_path):
    path = _path(tmp_path)
    _tool(path, track_id="host")
    ids = [c.id for c in load_project(Path(path)).clips if c.track_id == "host"]
    assert len(set(ids)) == 3
    assert "host-0" not in ids
    assert load_project(Path(path)).timeline.duration_sec == pytest.approx(3.2)


def test_a_track_with_no_silence_to_strip(tmp_path):
    expected = [(0.0, 6.0, 0.0, 0, 0, "fade")]
    service = _path(tmp_path / "service")
    assert _text(_service(service, track_id="host", min_duration_sec=2.0)) == NO_SILENCE
    handled = _path(tmp_path / "handler")
    assert _text(_handler(handled, track_id="host", min_duration_sec=2.0)) == NO_SILENCE
    tool = _path(tmp_path / "tool")
    assert _tool(tool, track_id="host", min_duration_sec=2.0) == NO_SILENCE
    cli = _path(tmp_path / "cli")
    result = _cli(cli, "--track", "host", "--min-duration", "2.0")
    assert (result.exit_code, result.stdout, result.stderr) == (0, NO_SILENCE + "\n", "")
    clips = [_clips(p) for p in (service, handled, tool, cli)]
    assert clips[0] == clips[1] == clips[2] == clips[3]
    assert [row[:3] for row in clips[0]] == [row[:3] for row in expected]


def test_a_track_without_contrast_has_no_silence(tmp_path):
    for name, run in (
        ("service", lambda p: _text(_service(p, track_id="guest"))),
        ("handler", lambda p: _text(_handler(p, track_id="guest"))),
        ("tool", lambda p: _tool(p, track_id="guest")),
    ):
        path = _path(tmp_path / name, guest="quiet")
        assert run(path) == NO_CONTRAST
        assert [row[:3] for row in _clips(path, "guest")] == [(0.0, 6.0, 0.0)]
    path = _path(tmp_path / "cli", guest="quiet")
    result = _cli(path, "--track", "guest")
    assert (result.exit_code, result.stdout, result.stderr) == (0, NO_CONTRAST + "\n", "")


def test_speaker_resolves_to_the_same_reply_on_every_path(tmp_path):
    for name, run in (
        ("service", lambda p: _text(_service(p, speaker="Host"))),
        ("handler", lambda p: _text(_handler(p, speaker="Host"))),
        ("tool", lambda p: _tool(p, speaker="Host")),
    ):
        path = _path(tmp_path / name, guest="quiet")
        assert run(path) == SILENCES_WITH_GUEST
        assert len(_clips(path)) == 3
    path = _path(tmp_path / "cli", guest="quiet")
    result = _cli(path, "--speaker", "Host")
    assert (result.exit_code, result.stdout, result.stderr) == (0, SILENCES_WITH_GUEST + "\n", "")


@pytest.mark.parametrize("flag", [None, True, False])
def test_use_inaudible_opt_is_ignored(tmp_path, flag):
    service = _path(tmp_path / "service")
    assert _text(_service(service, track_id="host", use_inaudible_opt=flag)) == SILENCES
    tool = _path(tmp_path / "tool")
    assert _tool(tool, track_id="host", use_inaudible_opt=flag) == SILENCES
    assert _clips(service) == _clips(tool) == [(*row, "fade") for row in ISLANDS]
    assert _entries(service)[1]["params"]["use_inaudible_opt"] is flag
    assert _entries(tool)[1]["params"]["use_inaudible_opt"] is flag


@pytest.mark.parametrize("flag", ["--inaudible-opt", "--no-inaudible-opt"])
def test_cli_inaudible_opt_flag_is_ignored(tmp_path, flag):
    path = _path(tmp_path)
    result = _cli(path, "--track", "host", flag)
    assert (result.exit_code, result.stdout) == (0, SILENCES + "\n")
    _islands(path)
    assert _entries(path)[1]["params"]["use_inaudible_opt"] is (flag == "--inaudible-opt")


def test_the_tool_journals_the_payload_and_the_reply(tmp_path):
    path = _path(tmp_path)
    _tool(path, speaker="Host")
    (row,) = DocumentSyncService.open(path).store.commands_after(0)
    assert (row["type"], row["client_id"], row["role"]) == ("StripSilence", "mcp-agent", "agent")
    assert list(row["payload"]) == [
        "track_id",
        "speaker",
        "over_voice_floor_db",
        "min_duration_sec",
        "use_inaudible_opt",
        "result",
    ]
    assert row["payload"] == {
        "track_id": None,
        "speaker": "Host",
        "over_voice_floor_db": 0.0,
        "min_duration_sec": 0.5,
        "use_inaudible_opt": None,
        "result": json.loads(SILENCES),
    }
    assert list(row["payload"]["result"]) == KEYS
    assert json.dumps(row["payload"]["result"], indent=2) == SILENCES


def test_the_tool_history_records_the_resolved_params(tmp_path):
    path = _path(tmp_path)
    _tool(path, speaker="Host", over_voice_floor_db=3.0, min_duration_sec=0.4)
    entries = _entries(path)
    assert [e["label"] for e in entries] == ["before strip silence", "after strip silence"]
    assert entries[1]["operation"] == "strip_silence"
    assert entries[1]["params"] == {
        "track_id": "host",
        "over_voice_floor_db": 3.0,
        "min_duration_sec": 0.4,
        "use_inaudible_opt": None,
    }


def test_the_cli_journals_one_external_row_and_history_params(tmp_path):
    path = _path(tmp_path)
    assert _cli(path, "--speaker", "Host", "--min-duration", "0.4").exit_code == 0
    assert _journal(path) == ["ExternalMutate"]
    entries = _entries(path)
    assert [e["label"] for e in entries] == ["before strip silence", "after strip silence"]
    assert entries[1]["operation"] == "strip_silence"
    assert entries[1]["params"] == {
        "track_id": "host",
        "over_voice_floor_db": 0.0,
        "min_duration_sec": 0.4,
        "use_inaudible_opt": True,
    }


def test_unknown_track_error_on_every_path(tmp_path):
    path = _path(tmp_path)
    before = Path(path).read_bytes()
    message = "unknown track_id: 'nope'"
    names = ["CodedValueError", "CodedValueError", "DocumentConflictError"]
    conflicts = [None, None, True]
    for index, run in enumerate(
        (
            lambda: _service(path, track_id="nope"),
            lambda: _handler(path, track_id="nope"),
            lambda: _tool(path, track_id="nope"),
        )
    ):
        with pytest.raises(CodedError) as raised:
            run()
        assert type(raised.value).__name__ == names[index]
        assert raised.value.code == "track_not_found"
        assert getattr(raised.value, "conflict", None) is conflicts[index]
        assert str(raised.value) == message
    result = _cli(path, "--track", "nope")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert (
        _err(result)
        == f"Error: {message} (code track_not_found) (set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert Path(path).read_bytes() == before
    assert _journal(path) == []
    assert _history(path)["total"] == 0


def test_missing_argument_error_on_every_path(tmp_path):
    path = _path(tmp_path)
    message = "track_id or speaker is required"
    for run in (lambda: _service(path), lambda: _tool(path)):
        with pytest.raises(CodedValueError) as raised:
            run()
        assert raised.value.code == "missing_argument"
        assert str(raised.value) == message
    result = _cli(path)
    assert result.exit_code == 1
    assert result.stdout == ""
    assert (
        _err(result)
        == f"Error: {message} (code missing_argument) (set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert _journal(path) == []


def test_a_track_without_media_error_on_every_path(tmp_path):
    path = _bare_path(tmp_path)
    before = Path(path).read_bytes()
    message = "track 'bare' not found or has no media"
    names = ["CodedValueError", "CodedValueError", "DocumentConflictError"]
    conflicts = [None, None, True]
    for index, run in enumerate(
        (
            lambda: _service(path, track_id="bare"),
            lambda: _handler(path, track_id="bare"),
            lambda: _tool(path, track_id="bare"),
        )
    ):
        with pytest.raises(CodedError) as raised:
            run()
        assert type(raised.value).__name__ == names[index]
        assert raised.value.code == "track_has_no_media"
        assert getattr(raised.value, "conflict", None) is conflicts[index]
        assert str(raised.value) == message
    result = _cli(path, "--track", "bare")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert (
        _err(result)
        == f"Error: {message} (code track_has_no_media) (set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert Path(path).read_bytes() == before
    assert _journal(path) == []
    assert _history(path)["total"] == 0


def test_an_unreadable_media_file_raises_called_process_error_and_the_cli_exits_nonzero(tmp_path):
    path = _path(tmp_path)
    (Path(path).parent / "raw" / "host.wav").write_bytes(b"this is not an audio container")
    before = Path(path).read_bytes()
    with pytest.raises(subprocess.CalledProcessError):
        _service(path, track_id="host")
    result = _cli(path, "--track", "host")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert _err(result) == ""
    assert isinstance(result.exception, subprocess.CalledProcessError)
    assert Path(path).read_bytes() == before
    assert _journal(path) == []
