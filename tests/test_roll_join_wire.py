"""Pin the wire output of ``TimelineService.roll_clip_join``.

The service, the ``roll_clip_join`` document handler, the ``RollClipJoin`` document command,
the ``edit roll-join`` CLI command (``json.dumps(indent=2)``) and ``roll_clip_join_tool``
(``to_json``) return the same dict. Nothing is normalized: the project is built in code with
explicit clip times. ``_as_dict`` lets the same expectations hold if the service returns a
model instead of a bare dict.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from history_helpers import history_move
from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.mcp.tools.timeline import roll_clip_join_tool
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document.boundary import RollBoundaryTarget, boundary_context
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "left_clip_id",
    "right_clip_id",
    "delta_sec",
    "left_source_end",
    "right_source_start",
]
UNCHANGED = {"operation": "roll_clip_join", "unchanged": True}
STALE = "boundary preview is stale; reload and listen again"
GAP_TEXT = (
    "These clips have a gap between them, so there is no join to roll. "
    "Move one clip to touch the other, or trim an edge instead."
)

# (id, source_start, source_end, timeline_start). c1|c2 abut; c2|c3 have a timeline gap;
# t1|t2 abut but t2 is at the minimum clip span, so a positive roll has no room.
CLIPS = [
    ("c1", 0.0, 5.0, 0.0),
    ("c2", 5.0, 25.0, 5.0),
    ("c3", 30.0, 40.0, 26.0),
    ("t1", 50.0, 55.0, 36.0),
    ("t2", 55.0, 55.05, 41.0),
]


def _as_dict(result: Any) -> dict:
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def _text(value) -> str:
    return json.dumps(value)


@pytest.fixture
def built(minimal_project) -> Path:
    project = load_project(minimal_project)
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    project.timeline.clips = [
        Clip(id=cid, track_id="host", source_start=s, source_end=e, timeline_start=ts)
        for cid, s, e, ts in CLIPS
    ]
    project.timeline.duration_sec = 41.05
    save_project(project)
    return minimal_project


def _token(path: Path, left: str = "c1", right: str = "c2") -> str:
    return boundary_context(
        load_project(path),
        RollBoundaryTarget(left_clip_id=left, right_clip_id=right),
        defaults=load_defaults(),
    ).token


def _roll(path: Path, left: str, right: str, delta: float, token: str | None = None) -> dict:
    return _as_dict(
        TimelineService(ProjectWorkspace.open(path)).roll_clip_join(
            left,
            right,
            delta,
            expected_token=token if token is not None else _token(path, left, right),
        )
    )


def _geometry(path: Path) -> list[tuple]:
    return sorted(
        (c.id, c.source_start, c.source_end, c.timeline_start) for c in load_project(path).clips
    )


def _history_len(path: Path) -> int:
    return len(load_project(path).history.entries)


def _applied(left: str, right: str, delta: float, left_end: float, right_start: float) -> dict:
    return {
        "operation": "roll_clip_join",
        "affected_tracks": ["host"],
        "clip_count": 5,
        "timeline_duration_sec": 41.05,
        "left_clip_id": left,
        "right_clip_id": right,
        "delta_sec": delta,
        "left_source_end": left_end,
        "right_source_start": right_start,
    }


# (case id, left, right, delta, expected). ``delta_sec`` echoes the request, not the clamp.
APPLIED_CASES = [
    ("positive", "c1", "c2", 2.0, _applied("c1", "c2", 2.0, 7.0, 7.0)),
    ("negative", "c1", "c2", -2.0, _applied("c1", "c2", -2.0, 3.0, 3.0)),
    ("clamped-high", "c1", "c2", 1000.0, _applied("c1", "c2", 1000.0, 24.95, 24.95)),
    (
        "clamped-low",
        "c1",
        "c2",
        -1000.0,
        _applied("c1", "c2", -1000.0, 0.04999999999999982, 0.04999999999999982),
    ),
    ("other-pair", "t1", "t2", -1.0, _applied("t1", "t2", -1.0, 54.0, 54.0)),
]
APPLIED_IDS = [case[0] for case in APPLIED_CASES]

# delta 0, and deltas that bound to 0 because the pair has no room that way.
UNCHANGED_CASES = [
    ("zero", "c1", "c2", 0.0),
    ("negative-zero", "c1", "c2", -0.0),
    ("no-room-forward", "t1", "t2", 3.0),
    ("no-room-forward-huge", "t1", "t2", 1000.0),
]
UNCHANGED_IDS = [case[0] for case in UNCHANGED_CASES]

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_BOX = re.compile(r"[│╭╮╰╯─]")


def _error_text(text: str) -> str:
    return " ".join(_BOX.sub(" ", _ANSI.sub("", text)).split())


def _cli(path: Path, left: str, right: str, delta: str):
    return runner.invoke(
        app,
        [
            "edit",
            "roll-join",
            "--project",
            str(path),
            "--left",
            left,
            "--right",
            right,
            "--delta-sec",
            delta,
        ],
    )


def _submit(path: Path, command_type: str, payload: dict) -> dict:
    return DocumentSyncService.open(path).submit(
        DocumentCommand(
            type=command_type, payload=payload, client_id="t", client_seq=None, role="viewer"
        )
    )


def _payload(path: Path, left: str, right: str, delta: float, **extra) -> dict:
    return {
        "left_clip_id": left,
        "right_clip_id": right,
        "delta_sec": delta,
        "expected_token": _token(path, left, right),
        **extra,
    }


def _raised(call) -> pytest.ExceptionInfo:
    with pytest.raises(Exception) as raised:
        call()
    return raised


# ------------------------------------------------------------------ service


@pytest.mark.parametrize(
    ("left", "right", "delta", "expected"), [c[1:] for c in APPLIED_CASES], ids=APPLIED_IDS
)
def test_service_applied_shapes(built, left, right, delta, expected):
    result = _roll(built, left, right, delta)
    assert list(result) == KEYS
    assert _text(result) == _text(expected)
    assert isinstance(result["clip_count"], int)
    assert isinstance(result["delta_sec"], float)


def test_service_applied_pinned_text(built):
    assert _text(_roll(built, "c1", "c2", 2.0)) == (
        '{"operation": "roll_clip_join", "affected_tracks": ["host"], "clip_count": 5, '
        '"timeline_duration_sec": 41.05, "left_clip_id": "c1", "right_clip_id": "c2", '
        '"delta_sec": 2.0, "left_source_end": 7.0, "right_source_start": 7.0}'
    )


def test_service_applied_geometry_and_history(built):
    entries = _history_len(built)
    _roll(built, "c1", "c2", 2.0)
    assert _geometry(built) == [
        ("c1", 0.0, 7.0, 0.0),
        ("c2", 7.0, 25.0, 7.0),
        ("c3", 30.0, 40.0, 26.0),
        ("t1", 50.0, 55.0, 36.0),
        ("t2", 55.0, 55.05, 41.0),
    ]
    assert _history_len(built) == entries + 2


@pytest.mark.parametrize(
    ("left", "right", "delta"), [c[1:] for c in UNCHANGED_CASES], ids=UNCHANGED_IDS
)
def test_service_unchanged_shortcut(built, left, right, delta):
    before, entries = _geometry(built), _history_len(built)
    result = _roll(built, left, right, delta)
    assert list(result) == ["operation", "unchanged"]
    assert result == UNCHANGED
    assert _text(result) == '{"operation": "roll_clip_join", "unchanged": true}'
    assert result["unchanged"] is True
    assert _geometry(built) == before
    assert _history_len(built) == entries


def test_service_stale_token(built):
    before, entries = _geometry(built), _history_len(built)
    raised = _raised(lambda: _roll(built, "c1", "c2", 2.0, token="bad"))
    assert type(raised.value).__name__ == "DocumentConflictError"
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE
    assert _geometry(built) == before
    assert _history_len(built) == entries


def test_service_token_goes_stale_after_the_edit(built):
    token = _token(built)
    _roll(built, "c1", "c2", 2.0, token=token)
    before = _geometry(built)
    raised = _raised(lambda: _roll(built, "c1", "c2", 1.0, token=token))
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE
    assert _geometry(built) == before


def test_service_unknown_clip(built):
    raised = _raised(lambda: _roll(built, "zz", "c2", 1.0, token="bad"))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown left_clip_id: 'zz'"


def test_service_non_abutting_clips(built):
    before, entries = _geometry(built), _history_len(built)
    raised = _raised(lambda: _roll(built, "c2", "c3", 1.0, token="bad"))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "roll_needs_abutting_clips"
    assert str(raised.value) == GAP_TEXT
    assert _geometry(built) == before
    assert _history_len(built) == entries


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_service_non_finite_delta_is_checked_before_the_token(built, value):
    raised = _raised(lambda: _roll(built, "c1", "c2", value, token="bad"))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "delta_sec_not_finite"
    assert str(raised.value) == "delta_sec must be finite"


# ------------------------------------------------------------------ undo / rollback


@pytest.mark.parametrize(
    ("left", "right", "delta"),
    [("c1", "c2", 2.0), ("c1", "c2", -2.0), ("c1", "c2", 1000.0), ("t1", "t2", -1.0)],
    ids=["positive", "negative", "clamped", "other-pair"],
)
def test_undo_restores_the_prior_timeline(built, left, right, delta):
    before = _geometry(built)
    duration = load_project(built).timeline.duration_sec
    _roll(built, left, right, delta)
    assert _geometry(built) != before

    _submit(built, "UndoHistory", history_move(built))

    assert _geometry(built) == before
    assert load_project(built).timeline.duration_sec == duration


def test_redo_reapplies_the_roll(built):
    _roll(built, "c1", "c2", 2.0)
    after = _geometry(built)
    _submit(built, "UndoHistory", history_move(built))
    _submit(built, "RedoHistory", history_move(built))
    assert _geometry(built) == after


def test_exception_inside_the_mutation_leaves_the_project_unchanged(built, monkeypatch):
    from podcast_mcp.edits import timeline_ops

    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(timeline_ops, "rebuild_combined", boom)
    before, entries = _geometry(built), _history_len(built)
    raised = _raised(lambda: _roll(built, "c1", "c2", 2.0))
    assert type(raised.value) is RuntimeError
    assert str(raised.value) == "boom"
    assert _geometry(built) == before
    assert _history_len(built) == entries
    assert load_project(built).timeline.duration_sec == 41.05


# ------------------------------------------------------------------ handler


@pytest.mark.parametrize(
    ("left", "right", "delta", "expected"), [c[1:] for c in APPLIED_CASES], ids=APPLIED_IDS
)
def test_handler_applied_equals_service(built, left, right, delta, expected):
    params = _payload(built, left, right, delta)
    result = handlers.roll_clip_join(ProjectWorkspace.open(built), params)
    assert list(result) == KEYS
    assert _text(result) == _text(expected)


@pytest.mark.parametrize(
    ("left", "right", "delta"), [c[1:] for c in UNCHANGED_CASES], ids=UNCHANGED_IDS
)
def test_handler_unchanged(built, left, right, delta):
    params = _payload(built, left, right, delta)
    result = handlers.roll_clip_join(ProjectWorkspace.open(built), params)
    assert _text(result) == _text(UNCHANGED)


def test_handler_stale_token(built):
    params = _payload(built, "c1", "c2", 2.0) | {"expected_token": "bad"}
    raised = _raised(lambda: handlers.roll_clip_join(ProjectWorkspace.open(built), params))
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE


# ------------------------------------------------------------------ document command


def test_document_command_applied_result_text(built):
    reply = _submit(built, "RollClipJoin", _payload(built, "c1", "c2", 2.0))
    assert reply["ok"] is True
    assert reply["type"] == "Applied"
    result = reply["command"]["payload"]["result"]
    assert list(result) == KEYS
    assert _text(result) == _text(APPLIED_CASES[0][-1])


def test_document_command_unchanged_result_text(built):
    reply = _submit(built, "RollClipJoin", _payload(built, "c1", "c2", 0.0))
    assert _text(reply["command"]["payload"]["result"]) == _text(UNCHANGED)


def test_document_command_stale_token(built):
    payload = _payload(built, "c1", "c2", 2.0) | {"expected_token": "bad"}
    raised = _raised(lambda: _submit(built, "RollClipJoin", payload))
    assert raised.value.code == "document_conflict"
    assert str(raised.value) == STALE


# ------------------------------------------------------------------ CLI


@pytest.mark.parametrize(
    ("left", "right", "delta", "expected"), [c[1:] for c in APPLIED_CASES], ids=APPLIED_IDS
)
def test_cli_applied(built, left, right, delta, expected):
    result = _cli(built, left, right, str(delta))
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(expected, indent=2) + "\n"


def test_cli_applied_pinned_text(built):
    result = _cli(built, "c1", "c2", "2")
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        "{\n"
        '  "operation": "roll_clip_join",\n'
        '  "affected_tracks": [\n'
        '    "host"\n'
        "  ],\n"
        '  "clip_count": 5,\n'
        '  "timeline_duration_sec": 41.05,\n'
        '  "left_clip_id": "c1",\n'
        '  "right_clip_id": "c2",\n'
        '  "delta_sec": 2.0,\n'
        '  "left_source_end": 7.0,\n'
        '  "right_source_start": 7.0\n'
        "}\n"
    )


@pytest.mark.parametrize(
    ("left", "right", "delta"), [c[1:] for c in UNCHANGED_CASES], ids=UNCHANGED_IDS
)
def test_cli_unchanged(built, left, right, delta):
    result = _cli(built, left, right, str(delta))
    assert result.exit_code == 0, result.output
    assert result.stdout == '{\n  "operation": "roll_clip_join",\n  "unchanged": true\n}\n'


def test_cli_unknown_clip(built):
    before = _geometry(built)
    result = _cli(built, "zz", "c2", "1")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert _error_text(result.stderr) == (
        "Error: unknown left_clip_id: 'zz' (code clip_not_found) "
        "(set PODCAST_DEBUG=1 for the traceback)"
    )
    assert isinstance(result.exception, SystemExit)
    assert _geometry(built) == before


def test_cli_non_abutting_clips(built):
    before = _geometry(built)
    result = _cli(built, "c2", "c3", "1")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert _error_text(result.stderr) == (
        f"Error: {GAP_TEXT} (code roll_needs_abutting_clips) "
        "(set PODCAST_DEBUG=1 for the traceback)"
    )
    assert _geometry(built) == before


def test_cli_non_adjacent_clips(built):
    result = _cli(built, "c2", "c1", "3")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert _error_text(result.stderr) == (
        "Error: right clip must be the next clip after left on the track. "
        "Pick two neighbouring clips on one track. (code clips_not_adjacent) "
        "(set PODCAST_DEBUG=1 for the traceback)"
    )


def test_cli_non_finite_delta(built):
    before = _geometry(built)
    result = _cli(built, "c1", "c2", "nan")
    assert result.exit_code == 1
    assert result.stdout == ""
    text = _error_text(result.stderr)
    assert text.startswith("Error: 1 validation error for RollClipJoinPayload delta_sec ")
    assert "Input should be a finite number" in text
    assert _geometry(built) == before


def test_cli_undo_restores_the_prior_timeline(built):
    before = _geometry(built)
    assert _cli(built, "c1", "c2", "2").exit_code == 0
    assert _geometry(built) != before
    _submit(built, "UndoHistory", history_move(built))
    assert _geometry(built) == before


# ------------------------------------------------------------------ MCP tool


def _tool(path: Path, left: str, right: str, delta: float) -> str:
    return roll_clip_join_tool(str(path), left, right, delta)


@pytest.mark.parametrize(
    ("left", "right", "delta", "expected"), [c[1:] for c in APPLIED_CASES], ids=APPLIED_IDS
)
def test_mcp_applied(built, left, right, delta, expected):
    out = _tool(built, left, right, delta)
    assert json.loads(out) == expected
    assert list(json.loads(out)) == KEYS
    assert out == json.dumps(expected, indent=2)


@pytest.mark.parametrize(
    ("left", "right", "delta"), [c[1:] for c in UNCHANGED_CASES], ids=UNCHANGED_IDS
)
def test_mcp_unchanged(built, left, right, delta):
    out = _tool(built, left, right, delta)
    assert out == '{\n  "operation": "roll_clip_join",\n  "unchanged": true\n}'


def test_mcp_unknown_clip(built):
    raised = _raised(lambda: _tool(built, "zz", "c2", 1.0))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown left_clip_id: 'zz'"


def test_mcp_non_abutting_clips(built):
    raised = _raised(lambda: _tool(built, "c2", "c3", 1.0))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "roll_needs_abutting_clips"
    assert str(raised.value) == GAP_TEXT


def test_mcp_non_finite_delta(built):
    raised = _raised(lambda: _tool(built, "c1", "c2", float("nan")))
    assert type(raised.value).__name__ == "ValidationError"
    (error,) = raised.value.errors()
    assert error["type"] == "finite_number"
    assert error["loc"] == ("delta_sec",)


def test_mcp_undo_restores_the_prior_timeline(built):
    before = _geometry(built)
    _tool(built, "c1", "c2", 2.0)
    assert _geometry(built) != before
    _submit(built, "UndoHistory", history_move(built))
    assert _geometry(built) == before
