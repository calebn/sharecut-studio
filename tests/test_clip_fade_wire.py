"""Pin the wire output of the set clip fade operation.

``TimelineService.set_clip_fade``, the SetClipFade document handler, the ``edit set-clip-fade``
CLI command (``json.dumps(indent=2)``) and ``set_clip_fade_tool`` (``to_json``) return the same
dict. Nothing is normalized: the project is built in code with explicit clip times.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.clip_fades import ClipFadeBaseline, ClipFadeChangedError
from podcast_mcp.mcp.tools.timeline import set_clip_fade_tool
from podcast_mcp.models import (
    Clip,
    FadeCurve,
    MediaAsset,
    Track,
    TrackRole,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.services.document_sync.payloads import SetClipFadePayload
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "fade_in_ms",
    "fade_out_ms",
    "clamped",
]
ZERO = ClipFadeBaseline(fade_in_ms=0, fade_out_ms=0)


def _fade(fade_in: int, fade_out: int, *, clamped: bool = False) -> dict:
    return {
        "operation": "set_clip_fade",
        "affected_tracks": ["host"],
        "clip_count": 1,
        "timeline_duration_sec": None,
        "fade_in_ms": fade_in,
        "fade_out_ms": fade_out,
        "clamped": clamped,
    }


def _text(value: Any) -> str:
    return json.dumps(value)


@pytest.fixture
def ws(minimal_project) -> ProjectWorkspace:
    opened = ProjectWorkspace.open(minimal_project)
    opened.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=2.0),
        )
    ]
    # A 0.5 s clip: 500 ms is the most its two fades can take together.
    opened.project.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0.5, source_end=1.0, timeline_start=0.0)
    ]
    save_project(opened.project, opened.path)
    return ProjectWorkspace.open(minimal_project)


def _clip(project_path) -> Clip:
    return next(c for c in ProjectWorkspace.open(project_path).project.clips if c.id == "a")


def _state(clip: Clip) -> tuple:
    return (clip.fade_in_ms, clip.fade_out_ms, clip.fade_in_curve.value, clip.fade_out_curve.value)


def _cli(minimal_project, *args: str):
    return runner.invoke(
        app, ["edit", "set-clip-fade", "--clip", "a", *args, "--project", str(minimal_project)]
    )


def _payload(**over: Any) -> dict:
    base = {"clip_id": "a", "fade_in_ms": 100, "fade_out_ms": 200, "expected": ZERO}
    return SetClipFadePayload(**{**base, **over}).model_dump(mode="json")


# --------------------------------------------------------------------------- service


@pytest.mark.parametrize(
    ("fade_in", "fade_out", "expected"),
    [
        (100, 200, _fade(100, 200)),
        (0, 0, _fade(0, 0)),
        (500, 0, _fade(500, 0)),
        (400, 400, _fade(400, 100, clamped=True)),
        (900, 900, _fade(500, 0, clamped=True)),
    ],
)
def test_service_set_clip_fade(ws, fade_in, fade_out, expected):
    result = TimelineService(ws).set_clip_fade("a", fade_in, fade_out).model_dump()
    assert type(result) is dict
    assert list(result) == KEYS
    assert _text(result) == _text(expected)
    for key in ("fade_in_ms", "fade_out_ms", "clip_count"):
        assert isinstance(result[key], int)
    assert isinstance(result["clamped"], bool)


def test_service_set_clip_fade_pinned_text(ws):
    result = TimelineService(ws).set_clip_fade("a", 400, 400).model_dump()
    assert _text(result) == (
        '{"operation": "set_clip_fade", "affected_tracks": ["host"], "clip_count": 1, '
        '"timeline_duration_sec": null, "fade_in_ms": 400, "fade_out_ms": 100, "clamped": true}'
    )


def test_service_set_clip_fade_with_curves(ws, minimal_project):
    result = (
        TimelineService(ws)
        .set_clip_fade(
            "a", 100, 200, fade_in_curve=FadeCurve.S, fade_out_curve=FadeCurve.EQUAL_POWER
        )
        .model_dump()
    )
    assert list(result) == KEYS
    assert "fade_in_curve" not in result
    assert _text(result) == _text(_fade(100, 200))
    assert _state(_clip(minimal_project)) == (100, 200, "s", "equal_power")


def test_service_set_clip_fade_curves_absent_keep_current(ws, minimal_project):
    service = TimelineService(ws)
    service.set_clip_fade("a", 100, 200, fade_in_curve=FadeCurve.S, fade_out_curve=FadeCurve.S)
    result = service.set_clip_fade("a", 50, 60).model_dump()
    assert _text(result) == _text(_fade(50, 60))
    assert _state(_clip(minimal_project)) == (50, 60, "s", "s")


def test_service_set_clip_fade_one_curve_only(ws, minimal_project):
    TimelineService(ws).set_clip_fade("a", 100, 200, fade_out_curve=FadeCurve.S)
    assert _state(_clip(minimal_project)) == (100, 200, "linear", "s")


def test_service_set_clip_fade_matching_baseline(ws):
    service = TimelineService(ws)
    service.set_clip_fade("a", 10, 20)
    baseline = ClipFadeBaseline(fade_in_ms=10, fade_out_ms=20)
    result = service.set_clip_fade("a", 30, 40, expected=baseline).model_dump()
    assert _text(result) == _text(_fade(30, 40))


# ---------------------------------------------------------------------- service: errors


def test_service_set_clip_fade_baseline_mismatch(ws, minimal_project):
    with pytest.raises(ClipFadeChangedError) as raised:
        TimelineService(ws).set_clip_fade(
            "a", 1, 1, expected=ClipFadeBaseline(fade_in_ms=5, fade_out_ms=0)
        )
    assert isinstance(raised.value, ValueError)
    assert raised.value.code == "clip_fade_changed"
    assert str(raised.value) == "This clip changed. Nothing was saved. Adjust the fade again."
    assert _state(_clip(minimal_project)) == (0, 0, "linear", "linear")


def test_service_set_clip_fade_curve_baseline_mismatch(ws):
    baseline = ClipFadeBaseline(fade_in_ms=0, fade_out_ms=0, fade_in_curve=FadeCurve.S)
    with pytest.raises(ClipFadeChangedError) as raised:
        TimelineService(ws).set_clip_fade("a", 1, 1, expected=baseline)
    assert raised.value.code == "clip_fade_changed"


def test_service_set_clip_fade_unknown_clip(ws):
    with pytest.raises(ValueError) as raised:
        TimelineService(ws).set_clip_fade("zz", 1, 1)
    assert type(raised.value) is CodedValueError
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown clip_id: 'zz'"


def test_service_set_clip_fade_unknown_clip_with_baseline(ws):
    with pytest.raises(ClipFadeChangedError) as raised:
        TimelineService(ws).set_clip_fade("zz", 1, 1, expected=ZERO)
    assert raised.value.code == "clip_fade_changed"


# ---------------------------------------------------------------------------- undo


def test_undo_restores_prior_fades(ws, minimal_project):
    service = TimelineService(ws)
    service.set_clip_fade("a", 100, 200, fade_in_curve=FadeCurve.S)
    assert _state(_clip(minimal_project)) == (100, 200, "s", "linear")
    service.set_clip_fade("a", 400, 400, fade_out_curve=FadeCurve.EQUAL_POWER)
    assert _state(_clip(minimal_project)) == (400, 100, "s", "equal_power")

    ProjectWorkspace.open(minimal_project).undo()
    assert _state(_clip(minimal_project)) == (100, 200, "s", "linear")
    ProjectWorkspace.open(minimal_project).undo()
    assert _state(_clip(minimal_project)) == (0, 0, "linear", "linear")


# --------------------------------------------------------------------- handler level


@pytest.mark.parametrize(
    ("over", "expected"),
    [
        ({}, _fade(100, 200)),
        ({"fade_in_ms": 0, "fade_out_ms": 0}, _fade(0, 0)),
        ({"fade_in_ms": 400, "fade_out_ms": 400}, _fade(400, 100, clamped=True)),
        ({"fade_in_curve": "s", "fade_out_curve": "equal_power"}, _fade(100, 200)),
    ],
)
def test_handler_set_clip_fade_equals_service(minimal_project, ws, over, expected):
    params = _payload(**over)
    via_handler = handlers.set_clip_fade(ws, params)
    assert list(via_handler) == KEYS
    assert _text(via_handler) == _text(expected)
    first = _state(_clip(minimal_project))

    # Reset to the saved baseline, then run the same edit through the service.
    reset = ProjectWorkspace.open(minimal_project)
    reset.project.clips[0].fade_in_ms = reset.project.clips[0].fade_out_ms = 0
    reset.project.clips[0].fade_in_curve = reset.project.clips[0].fade_out_curve = FadeCurve.LINEAR
    save_project(reset.project, reset.path)
    via_service = (
        TimelineService(ProjectWorkspace.open(minimal_project))
        .set_clip_fade(
            "a",
            params["fade_in_ms"],
            params["fade_out_ms"],
            expected=ZERO,
            fade_in_curve=FadeCurve(params["fade_in_curve"]) if params["fade_in_curve"] else None,
            fade_out_curve=FadeCurve(params["fade_out_curve"])
            if params["fade_out_curve"]
            else None,
        )
        .model_dump()
    )
    assert _text(via_handler) == _text(via_service)
    assert _state(_clip(minimal_project)) == first


def test_handler_set_clip_fade_baseline_mismatch(ws, minimal_project):
    params = _payload(expected={"fade_in_ms": 7, "fade_out_ms": 0})
    with pytest.raises(ClipFadeChangedError) as raised:
        handlers.set_clip_fade(ws, params)
    assert raised.value.code == "clip_fade_changed"
    assert str(raised.value) == "This clip changed. Nothing was saved. Adjust the fade again."
    assert _state(_clip(minimal_project)) == (0, 0, "linear", "linear")


def test_handler_set_clip_fade_unknown_clip(ws):
    with pytest.raises(ClipFadeChangedError) as raised:
        handlers.set_clip_fade(ws, _payload(clip_id="zz"))
    assert raised.value.code == "clip_fade_changed"


def test_handler_set_clip_fade_curve_keys_absent(ws, minimal_project):
    params = {
        "clip_id": "a",
        "fade_in_ms": 30,
        "fade_out_ms": 40,
        "expected": {"fade_in_ms": 0, "fade_out_ms": 0},
    }
    result = handlers.set_clip_fade(ws, params)
    assert _text(result) == _text(_fade(30, 40))
    assert _state(_clip(minimal_project)) == (30, 40, "linear", "linear")


# ------------------------------------------------------------------------- CLI level


def test_cli_set_clip_fade_both(ws, minimal_project):
    result = _cli(minimal_project, "--fade-in-ms", "100", "--fade-out-ms", "200")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(_fade(100, 200), indent=2) + "\n"
    assert result.stdout == (
        "{\n"
        '  "operation": "set_clip_fade",\n'
        '  "affected_tracks": [\n'
        '    "host"\n'
        "  ],\n"
        '  "clip_count": 1,\n'
        '  "timeline_duration_sec": null,\n'
        '  "fade_in_ms": 100,\n'
        '  "fade_out_ms": 200,\n'
        '  "clamped": false\n'
        "}\n"
    )


def test_cli_set_clip_fade_clamped(ws, minimal_project):
    result = _cli(minimal_project, "--fade-in-ms", "400", "--fade-out-ms", "400")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(_fade(400, 100, clamped=True), indent=2) + "\n"
    assert result.stdout.endswith('  "fade_out_ms": 100,\n  "clamped": true\n}\n')


def test_cli_set_clip_fade_zero(ws, minimal_project):
    result = _cli(minimal_project, "--fade-in-ms", "0", "--fade-out-ms", "0")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(_fade(0, 0), indent=2) + "\n"


def test_cli_set_clip_fade_left_out_keeps_current(ws, minimal_project):
    TimelineService(ws).set_clip_fade("a", 10, 20)
    result = _cli(minimal_project, "--fade-in-ms", "5")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(_fade(5, 20), indent=2) + "\n"


def test_cli_set_clip_fade_curves(ws, minimal_project):
    result = _cli(minimal_project, "--fade-in-curve", "s", "--fade-out-curve", "equal_power")
    assert result.exit_code == 0, result.output
    assert result.stdout == json.dumps(_fade(0, 0), indent=2) + "\n"
    assert _state(_clip(minimal_project)) == (0, 0, "s", "equal_power")


def test_cli_set_clip_fade_unknown_clip(ws, minimal_project):
    result = runner.invoke(
        app,
        [
            "edit",
            "set-clip-fade",
            "--clip",
            "zz",
            "--fade-in-ms",
            "5",
            "--project",
            str(minimal_project),
        ],
    )
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.output == (
        "Error: unknown clip_id: 'zz' (code clip_not_found) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    assert isinstance(result.exception, SystemExit)


# -------------------------------------------------------------------------- MCP tool


def test_tool_set_clip_fade(ws, minimal_project):
    out = set_clip_fade_tool(str(minimal_project), "a", 100, 200)
    assert out == json.dumps(_fade(100, 200), indent=2)


def test_tool_set_clip_fade_clamped_with_curves(ws, minimal_project):
    out = set_clip_fade_tool(str(minimal_project), "a", 400, 400, "s", "equal_power")
    assert out == json.dumps(_fade(400, 100, clamped=True), indent=2)
    assert _state(_clip(minimal_project)) == (400, 100, "s", "equal_power")


def test_tool_set_clip_fade_zero(ws, minimal_project):
    out = set_clip_fade_tool(str(minimal_project), "a", 0, 0)
    assert out == json.dumps(_fade(0, 0), indent=2)


def test_tool_set_clip_fade_unknown_clip(ws, minimal_project):
    with pytest.raises(CodedValueError) as raised:
        set_clip_fade_tool(str(minimal_project), "zz", 1, 1)
    assert raised.value.code == "clip_not_found"
    assert str(raised.value) == "unknown clip_id: 'zz'"
