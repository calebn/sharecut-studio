"""Pin the wire output of the join setters.

``TimelineService.set_join_mode`` / ``set_clip_join``, the SetJoinMode / SetClipJoin document
handlers and the ``edit set-clip-join`` CLI command (``json.dumps(indent=2)``) return the same
dicts. Nothing is normalized: the projects are built in code over the generated tone.
"""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.services.document_sync.payloads import SetClipJoinPayload, SetJoinModePayload
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

MODE_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "join_left_clip_id",
    "join_render_mode",
    "join_crossfade_ms",
    "join_crossfade_blocked",
]
MODE_BORROW_KEYS = [*MODE_KEYS, "join_borrow_sec"]
JOIN_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "left_clip_id",
    "right_clip_id",
    "join_in_mode",
    "left_fade_out_ms",
    "right_fade_in_ms",
    "crossfade_ms",
    "crossfade_blocked",
]


def _mode(*, left, render, ms=0, blocked=None, borrow=None, operation="set_clip_join_mode") -> dict:
    out = {
        "operation": operation,
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": None,
        "join_left_clip_id": left,
        "join_render_mode": render,
        "join_crossfade_ms": ms,
        "join_crossfade_blocked": blocked,
    }
    if borrow is not None:
        out["join_borrow_sec"] = borrow
    return out


def _join(*, mode, fade_out, fade_in, ms=0, blocked=None) -> dict:
    return {
        "operation": "set_clip_join",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": None,
        "left_clip_id": "a",
        "right_clip_id": "b",
        "join_in_mode": mode,
        "left_fade_out_ms": fade_out,
        "right_fade_in_ms": fade_in,
        "crossfade_ms": ms,
        "crossfade_blocked": blocked,
    }


def _open(minimal_project, clips, *, media_sec=2.0, fades=(0, 0)) -> ProjectWorkspace:
    opened = ProjectWorkspace.open(minimal_project)
    opened.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=media_sec),
        )
    ]
    clips[0].fade_out_ms, clips[1].fade_in_ms = fades
    opened.project.timeline.clips = clips
    save_project(opened.project, opened.path)
    return ProjectWorkspace.open(minimal_project)


def _abutting(*, gap: float = 0.0) -> list[Clip]:
    return [
        Clip(id="a", track_id="host", source_start=0.5, source_end=1.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=1.0, source_end=1.5, timeline_start=0.5 + gap),
    ]


@pytest.fixture
def ws(minimal_project) -> ProjectWorkspace:
    return _open(minimal_project, _abutting())


@pytest.fixture
def ws_fades(minimal_project) -> ProjectWorkspace:
    return _open(minimal_project, _abutting(), fades=(25, 25))


@pytest.fixture
def ws_gap(minimal_project) -> ProjectWorkspace:
    return _open(minimal_project, _abutting(gap=0.4), fades=(25, 25))


@pytest.fixture
def ws_no_headroom(minimal_project) -> ProjectWorkspace:
    clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=1.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=0.0, source_end=1.0, timeline_start=1.0),
    ]
    return _open(minimal_project, clips, media_sec=1.0, fades=(25, 25))


def _cli(minimal_project, *args: str):
    return runner.invoke(app, ["edit", *args, "--project", str(minimal_project)])


def _text(value: dict) -> str:
    return json.dumps(value)


# --------------------------------------------------------------- service: set_join_mode


@pytest.mark.parametrize(
    ("mode", "expected", "keys"),
    [
        ("fade", _mode(left="a", render="fade"), MODE_KEYS),
        ("cut", _mode(left="a", render="cut"), MODE_KEYS),
        (
            "crossfade",
            _mode(left="a", render="crossfade", ms=20, borrow=0.01),
            MODE_BORROW_KEYS,
        ),
    ],
)
def test_service_set_join_mode_with_previous_clip(ws_fades, mode, expected, keys):
    result = TimelineService(ws_fades).set_join_mode("b", mode)
    assert list(result) == keys
    assert _text(result) == _text(expected)


def test_service_set_join_mode_pinned_text(ws_fades):
    result = TimelineService(ws_fades).set_join_mode("b", "crossfade")
    assert _text(result) == (
        '{"operation": "set_clip_join_mode", "affected_tracks": ["host"], "clip_count": 2, '
        '"timeline_duration_sec": null, "join_left_clip_id": "a", "join_render_mode": '
        '"crossfade", "join_crossfade_ms": 20, "join_crossfade_blocked": null, '
        '"join_borrow_sec": 0.01}'
    )
    assert isinstance(result["join_crossfade_ms"], int)
    assert isinstance(result["join_borrow_sec"], float)
    assert isinstance(result["clip_count"], int)


def test_service_set_join_mode_crossfade_without_fades_is_blocked(ws):
    result = TimelineService(ws).set_join_mode("b", "crossfade")
    assert list(result) == MODE_KEYS
    assert "join_borrow_sec" not in result
    assert _text(result) == _text(_mode(left="a", render="crossfade", blocked="no_fade_out"))


@pytest.mark.parametrize("mode", ["fade", "crossfade", "cut"])
def test_service_set_join_mode_first_clip(ws_fades, mode):
    result = TimelineService(ws_fades).set_join_mode("a", mode)
    assert list(result) == MODE_KEYS
    assert result["join_left_clip_id"] is None
    assert result["join_crossfade_ms"] == 0
    assert _text(result) == _text(_mode(left=None, render=None))


def test_service_set_join_mode_crossfade_not_abutting(ws_gap):
    result = TimelineService(ws_gap).set_join_mode("b", "crossfade")
    assert list(result) == MODE_KEYS
    assert "join_borrow_sec" not in result
    assert isinstance(result["join_crossfade_blocked"], str)
    assert _text(result) == _text(_mode(left="a", render="crossfade", blocked="not_abutting"))


def test_service_set_join_mode_crossfade_no_headroom(ws_no_headroom):
    result = TimelineService(ws_no_headroom).set_join_mode("b", "crossfade")
    assert list(result) == MODE_KEYS
    assert "join_borrow_sec" not in result
    assert isinstance(result["join_crossfade_blocked"], str)
    assert _text(result) == _text(_mode(left="a", render="crossfade", blocked="no_headroom"))


# --------------------------------------------------------------- service: set_clip_join


def test_service_set_clip_join_crossfade_default_length(ws):
    result = TimelineService(ws).set_clip_join("a", "b", "crossfade")
    assert list(result) == JOIN_KEYS
    assert "join_borrow_sec" not in result
    assert _text(result) == _text(_join(mode="crossfade", fade_out=25, fade_in=25, ms=20))
    assert _text(result) == (
        '{"operation": "set_clip_join", "affected_tracks": ["host"], "clip_count": 2, '
        '"timeline_duration_sec": null, "left_clip_id": "a", "right_clip_id": "b", '
        '"join_in_mode": "crossfade", "left_fade_out_ms": 25, "right_fade_in_ms": 25, '
        '"crossfade_ms": 20, "crossfade_blocked": null}'
    )
    for key in ("left_fade_out_ms", "right_fade_in_ms", "crossfade_ms"):
        assert isinstance(result[key], int)


def test_service_set_clip_join_crossfade_explicit_length(ws):
    result = TimelineService(ws).set_clip_join("a", "b", "crossfade", 40)
    assert list(result) == JOIN_KEYS
    assert _text(result) == _text(_join(mode="crossfade", fade_out=40, fade_in=40, ms=40))


def test_service_set_clip_join_cut_zeroes_fades(ws_fades):
    result = TimelineService(ws_fades).set_clip_join("a", "b", "cut")
    assert list(result) == JOIN_KEYS
    assert _text(result) == _text(_join(mode="cut", fade_out=0, fade_in=0))


def test_service_set_clip_join_fade_keeps_current_fades(minimal_project):
    ws = _open(minimal_project, _abutting(), fades=(30, 5))
    result = TimelineService(ws).set_clip_join("a", "b", "fade")
    assert list(result) == JOIN_KEYS
    assert _text(result) == _text(_join(mode="fade", fade_out=30, fade_in=5))


def test_service_set_clip_join_fade_seeds_micro_fade(ws):
    result = TimelineService(ws).set_clip_join("a", "b", "fade")
    assert list(result) == JOIN_KEYS
    assert _text(result) == _text(_join(mode="fade", fade_out=10, fade_in=10))


def test_service_set_clip_join_fade_explicit_length(ws):
    result = TimelineService(ws).set_clip_join("a", "b", "fade", 12)
    assert _text(result) == _text(_join(mode="fade", fade_out=12, fade_in=12))


def test_service_set_clip_join_crossfade_not_abutting(ws_gap):
    result = TimelineService(ws_gap).set_clip_join("a", "b", "crossfade")
    assert list(result) == JOIN_KEYS
    assert isinstance(result["crossfade_blocked"], str)
    assert _text(result) == _text(
        _join(mode="crossfade", fade_out=25, fade_in=25, blocked="not_abutting")
    )


def test_service_set_clip_join_crossfade_no_headroom(ws_no_headroom):
    result = TimelineService(ws_no_headroom).set_clip_join("a", "b", "crossfade")
    assert list(result) == JOIN_KEYS
    assert _text(result) == _text(
        _join(mode="crossfade", fade_out=25, fade_in=25, blocked="no_headroom")
    )


# ---------------------------------------------------------------------- service: errors


def _raised(call) -> pytest.ExceptionInfo:
    with pytest.raises(ValueError) as raised:
        call()
    return raised


def test_service_set_join_mode_unknown_clip(ws):
    raised = _raised(lambda: TimelineService(ws).set_join_mode("zz", "fade"))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown clip_id: 'zz'"


def test_service_set_join_mode_invalid_mode(ws):
    raised = _raised(lambda: TimelineService(ws).set_join_mode("b", "wobble"))
    assert type(raised.value) is ValueError
    assert str(raised.value) == "'wobble' is not a valid ClipJoinMode"


def test_service_set_clip_join_unknown_clip(ws):
    raised = _raised(lambda: TimelineService(ws).set_clip_join("a", "zz", "fade"))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown right_clip_id: 'zz'"


def test_service_set_clip_join_invalid_mode(ws):
    raised = _raised(lambda: TimelineService(ws).set_clip_join("a", "b", "wobble"))
    assert type(raised.value) is ValueError
    assert str(raised.value) == "'wobble' is not a valid ClipJoinMode"


def test_service_set_clip_join_negative_length(ws):
    raised = _raised(lambda: TimelineService(ws).set_clip_join("a", "b", "fade", -1))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "out_of_range"
    assert str(raised.value) == "length_ms must be >= 0. Pass 0 or more."


def test_service_set_clip_join_crossfade_length_zero(ws):
    raised = _raised(lambda: TimelineService(ws).set_clip_join("a", "b", "crossfade", 0))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "out_of_range"
    assert str(raised.value) == "crossfade length_ms must be > 0. Pass more than 0."


def test_service_set_clip_join_not_neighbours(ws):
    raised = _raised(lambda: TimelineService(ws).set_clip_join("b", "a", "fade"))
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clips_not_adjacent"
    assert str(raised.value) == (
        "right clip must be the next clip after left on the track. "
        "Pick two neighbouring clips on one track."
    )


# --------------------------------------------------------------------- handler level


def test_handler_set_join_mode_equals_service(minimal_project):
    params = SetJoinModePayload(clip_id="b", join_in_mode="crossfade").model_dump(mode="json")
    via_handler = handlers.set_join_mode(
        _open(minimal_project, _abutting(), fades=(25, 25)), params
    )
    via_service = TimelineService(
        _open(minimal_project, _abutting(), fades=(25, 25))
    ).set_join_mode("b", "crossfade")
    assert list(via_handler) == MODE_BORROW_KEYS
    assert _text(via_handler) == _text(via_service)
    assert _text(via_handler) == _text(_mode(left="a", render="crossfade", ms=20, borrow=0.01))


@pytest.mark.parametrize(
    ("mode", "length_ms", "expected"),
    [
        ("crossfade", None, _join(mode="crossfade", fade_out=25, fade_in=25, ms=20)),
        ("crossfade", 40, _join(mode="crossfade", fade_out=40, fade_in=40, ms=40)),
        ("cut", None, _join(mode="cut", fade_out=0, fade_in=0)),
        ("fade", 12, _join(mode="fade", fade_out=12, fade_in=12)),
    ],
)
def test_handler_set_clip_join_equals_service(minimal_project, mode, length_ms, expected):
    params = SetClipJoinPayload(
        left_clip_id="a", right_clip_id="b", mode=mode, length_ms=length_ms
    ).model_dump(mode="json")
    via_handler = handlers.set_clip_join(_open(minimal_project, _abutting()), params)
    via_service = TimelineService(_open(minimal_project, _abutting())).set_clip_join(
        "a", "b", mode, length_ms
    )
    assert list(via_handler) == JOIN_KEYS
    assert _text(via_handler) == _text(via_service)
    assert _text(via_handler) == _text(expected)


def test_handler_set_clip_join_without_length_key(minimal_project):
    params = {"left_clip_id": "a", "right_clip_id": "b", "mode": "fade"}
    result = handlers.set_clip_join(_open(minimal_project, _abutting()), params)
    assert _text(result) == _text(_join(mode="fade", fade_out=10, fade_in=10))


# ------------------------------------------------------------------------- CLI level


def _clip_args(*extra: str) -> list[str]:
    return ["set-clip-join", "--left", "a", "--right", "b", *extra]


def test_cli_set_clip_join_crossfade(ws, minimal_project):
    result = _cli(minimal_project, *_clip_args("--mode", "crossfade"))
    assert result.exit_code == 0, result.output
    expected = _join(mode="crossfade", fade_out=25, fade_in=25, ms=20)
    assert result.stdout == json.dumps(expected, indent=2) + "\n"
    assert result.stdout == (
        "{\n"
        '  "operation": "set_clip_join",\n'
        '  "affected_tracks": [\n'
        '    "host"\n'
        "  ],\n"
        '  "clip_count": 2,\n'
        '  "timeline_duration_sec": null,\n'
        '  "left_clip_id": "a",\n'
        '  "right_clip_id": "b",\n'
        '  "join_in_mode": "crossfade",\n'
        '  "left_fade_out_ms": 25,\n'
        '  "right_fade_in_ms": 25,\n'
        '  "crossfade_ms": 20,\n'
        '  "crossfade_blocked": null\n'
        "}\n"
    )


def test_cli_set_clip_join_crossfade_length(ws, minimal_project):
    result = _cli(minimal_project, *_clip_args("--mode", "crossfade", "--length-ms", "40"))
    assert result.exit_code == 0, result.output
    expected = _join(mode="crossfade", fade_out=40, fade_in=40, ms=40)
    assert result.stdout == json.dumps(expected, indent=2) + "\n"


def test_cli_set_clip_join_cut(ws_fades, minimal_project):
    result = _cli(minimal_project, *_clip_args("--mode", "cut"))
    assert result.exit_code == 0, result.output
    expected = _join(mode="cut", fade_out=0, fade_in=0)
    assert result.stdout == json.dumps(expected, indent=2) + "\n"
    assert '\n  "left_fade_out_ms": 0,\n  "right_fade_in_ms": 0,\n' in result.stdout


def test_cli_set_clip_join_blocked(ws_gap, minimal_project):
    result = _cli(minimal_project, *_clip_args("--mode", "crossfade"))
    assert result.exit_code == 0, result.output
    expected = _join(mode="crossfade", fade_out=25, fade_in=25, blocked="not_abutting")
    assert result.stdout == json.dumps(expected, indent=2) + "\n"
    assert result.stdout.endswith(
        '  "crossfade_ms": 0,\n  "crossfade_blocked": "not_abutting"\n}\n'
    )


def test_cli_set_clip_join_unknown_clip(ws, minimal_project):
    result = _cli(
        minimal_project, "set-clip-join", "--left", "a", "--right", "zz", "--mode", "fade"
    )
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.output == (
        "Error: unknown right_clip_id: 'zz' (code clip_not_found) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert isinstance(result.exception, SystemExit)
