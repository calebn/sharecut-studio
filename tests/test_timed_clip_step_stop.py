"""A trim or roll held by a timing correction says so and how to go further (#2859, #1089)."""

from __future__ import annotations

import json
import wave
from pathlib import Path
from typing import Literal

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.ripple import plan_trim
from podcast_mcp.engines.clips_ops import roll_step_stop
from podcast_mcp.mcp.tools.timeline import trim_clip_edge_tool
from podcast_mcp.models import Clip, EditMode, EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.boundary import (
    RollBoundaryTarget,
    TrimBoundaryTarget,
    boundary_context,
)
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.util.coded_error import CodedValueError

pytestmark = pytest.mark.unscoped_ok

_DEFAULTS = load_defaults()
_STEP = [{"at": 20, "delta_sec": 2}]
_TRIM_TEXT = (
    "This edge stopped at {stopped} s of the recording because a timing correction at "
    "20.00 s sits inside the clip, and an edge cannot move across a correction."
)


def _clip(clip_id: str, start: float, end: float, at: float, steps: list | None) -> Clip:
    data: dict = {
        "id": clip_id,
        "track_id": "host",
        "source_start": start,
        "source_end": end,
        "timeline_start": at,
    }
    if steps is not None:
        data["timing"] = {"steps": steps}
    return Clip.model_validate(data)


def _project(clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject.create("step_stop", "/tmp/ws-step-stop")
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=300.0))
    ]
    project.timeline.clips = clips
    return project


def _roll_pair() -> EpisodeProject:
    a = _clip("a", 10, 40, 0, _STEP)
    b = _clip("b", 40, 50, a.timeline_end, [{"at": 45, "delta_sec": 1}])
    return _project([a, b])


# ---------------------------------------------------------------- pure engine


@pytest.mark.parametrize(
    ("edge", "sec", "stopped"),
    [("out", 15.0, 20.000001), ("in", 1000.0, 19.999999), ("in", 30.0, 19.999999)],
)
def test_trim_plan_names_the_correction_that_held_the_edge(edge, sec, stopped) -> None:
    project = _project([_clip("a", 10, 40, 0, _STEP)])
    stop = plan_trim(project, "a", edge, sec, EditMode.RIPPLE).step_stop
    assert stop is not None
    assert (stop.clip_id, stop.edge, stop.step_at_sec) == ("a", edge, 20.0)
    assert stop.stopped_at_sec == pytest.approx(stopped)


@pytest.mark.parametrize(
    ("edge", "sec", "steps"),
    [
        ("out", 35.0, _STEP),  # past the correction, so it did not hold the edge
        ("in", 12.0, _STEP),  # short of the correction
        ("out", 35.0, None),  # untimed clip: nothing to name
        ("in", 12.0, None),
    ],
)
def test_trim_plan_is_silent_when_no_correction_held_the_edge(edge, sec, steps) -> None:
    project = _project([_clip("a", 10, 40, 0, steps)])
    assert plan_trim(project, "a", edge, sec, EditMode.RIPPLE).step_stop is None


def test_trim_plan_is_silent_when_the_neighbour_held_an_untimed_edge() -> None:
    neighbour = _clip("n", 20, 50, 30, None)
    project = _project([_clip("a", 10, 40, 0, None), neighbour])
    assert plan_trim(project, "a", "out", 35.0, EditMode.RIPPLE).step_stop is None


def test_roll_names_the_clip_whose_correction_held_each_direction() -> None:
    project = _roll_pair()
    later = roll_step_stop(project, "a", "b", 1000.0)
    assert later is not None
    assert (later.clip_id, later.edge, later.step_at_sec) == ("b", "in", 45.0)
    assert later.stopped_at_sec == pytest.approx(44.999999)
    earlier = roll_step_stop(project, "a", "b", -1000.0)
    assert earlier is not None
    assert (earlier.clip_id, earlier.edge, earlier.step_at_sec) == ("a", "out", 20.0)
    assert earlier.stopped_at_sec == pytest.approx(20.000001)
    assert roll_step_stop(project, "a", "b", 1.0) is None
    untimed = _project([_clip("a", 10, 40, 0, None), _clip("b", 40, 50, 30, None)])
    assert roll_step_stop(untimed, "a", "b", 1000.0) is None
    assert roll_step_stop(untimed, "a", "b", -1000.0) is None


# ---------------------------------------------------------------- no legal range text


@pytest.mark.parametrize("timed", [False, True], ids=["untimed", "timed"])
def test_no_legal_range_text_depends_on_the_clip(timed: bool) -> None:
    # The neighbour starts inside the clip's 0.05 s minimum span, so no position is legal.
    # Untimed: neighbour at 10.0 overlaps 10.05; timed: neighbour at 12 sits left of the
    # step's clearance.
    clip = _clip("a", 10, 40, 0, _STEP if timed else None)
    neighbour = _clip("n", 12 if timed else 10, 50, clip.timeline_end, None)
    project = _project([clip, neighbour])
    with pytest.raises(CodedValueError) as plan_error:
        plan_trim(project, "a", "out", 35.0, EditMode.RIPPLE)
    target = TrimBoundaryTarget(clip_id="a", edge="out", mode=EditMode.RIPPLE)
    with pytest.raises(CodedValueError) as context_error:
        boundary_context(project, target, defaults=_DEFAULTS)
    assert plan_error.value.code == "trim_no_legal_range"
    assert context_error.value.code == "boundary_no_legal_range"
    assert str(plan_error.value) == str(context_error.value)
    text = str(plan_error.value)
    assert text.startswith("This edge cannot move: ")
    assert ("correction" in text) is timed
    assert text.endswith("leaves it no legal position.")


# ---------------------------------------------------------------- real project


def _media(project: EpisodeProject) -> None:
    path = project.raw_dir() / "host.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        audio.writeframes(bytes(60 * 16_000 * 2))


def _built(minimal_project: Path, clips: list[Clip]) -> Path:
    ws = ProjectWorkspace.open(minimal_project)
    _media(ws.project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60.0),
        )
    ]
    ws.project.timeline.clips = clips
    ws.save()
    return minimal_project


def _trim_params(path: Path, edge: Literal["in", "out"], sec: float) -> dict:
    target = TrimBoundaryTarget(clip_id="a", edge=edge, mode=EditMode.RIPPLE)
    token = boundary_context(ProjectWorkspace.open(path).project, target, defaults=_DEFAULTS).token
    return {
        "clip_id": "a",
        "edge": edge,
        "source_sec": sec,
        "mode": "ripple",
        "expected_token": token,
    }


def _roll_params(path: Path, delta: float) -> dict:
    token = boundary_context(
        ProjectWorkspace.open(path).project,
        RollBoundaryTarget(left_clip_id="a", right_clip_id="b"),
        defaults=_DEFAULTS,
    ).token
    return {"left_clip_id": "a", "right_clip_id": "b", "delta_sec": delta, "expected_token": token}


def _trim(path: Path, edge: Literal["in", "out"], sec: float) -> dict:
    return handlers.trim_clip_edge(ProjectWorkspace.open(path), _trim_params(path, edge, sec))


def _roll(path: Path, delta: float) -> dict:
    return handlers.roll_clip_join(ProjectWorkspace.open(path), _roll_params(path, delta))


def test_trim_handler_says_why_it_stopped_applied_and_unchanged(minimal_project: Path) -> None:
    path = _built(minimal_project, [_clip("a", 10, 40, 0, _STEP)])
    applied = _trim(path, "out", 15.0)
    note = applied["step_stop"]
    assert note == {
        "clip_id": "a",
        "edge": "out",
        "step_at_sec": 20.0,
        "stopped_at_sec": pytest.approx(20.000001),
        "message": _TRIM_TEXT.format(stopped="20.00"),
    }
    again = _trim(path, "out", 15.0)
    assert again["unchanged"] is True
    assert again["step_stop"] == note
    assert "step_stop" not in _trim(path, "out", 25.0)


def test_roll_handler_says_why_it_stopped_applied_and_unchanged(minimal_project: Path) -> None:
    a = _clip("a", 10, 40, 0, _STEP)
    b = _clip("b", 40, 50, a.timeline_end, [{"at": 45, "delta_sec": 1}])
    path = _built(minimal_project, [a, b])
    applied = _roll(path, -1000.0)
    note = applied["step_stop"]
    assert note["clip_id"] == "a"
    assert note["edge"] == "out"
    assert note["step_at_sec"] == 20.0
    assert note["message"] == (
        "This join stopped at 20.00 s of the recording because a timing correction at "
        "20.00 s sits inside the left clip, and a join cannot move across a correction."
    )
    again = _roll(path, -1000.0)
    assert again["unchanged"] is True
    assert again["step_stop"] == note
    assert "step_stop" not in _roll(path, 1.0)


def test_mcp_trim_tool_returns_the_reason(minimal_project: Path) -> None:
    path = _built(minimal_project, [_clip("a", 10, 40, 0, _STEP)])
    out = json.loads(trim_clip_edge_tool(str(path), "a", "out", 15.0))
    assert out["step_stop"]["message"] == _TRIM_TEXT.format(stopped="20.00")


def test_cli_roll_join_prints_the_reason(minimal_project: Path) -> None:
    a = _clip("a", 10, 40, 0, _STEP)
    b = _clip("b", 40, 50, a.timeline_end, [{"at": 45, "delta_sec": 1}])
    path = _built(minimal_project, [a, b])
    args = ["edit", "roll-join", "--project", str(path), "--left", "a", "--right", "b"]
    result = CliRunner().invoke(app, [*args, "--delta-sec", "1000"])
    assert result.exit_code == 0, result.output
    note = json.loads(result.output)["step_stop"]
    assert (note["clip_id"], note["edge"], note["step_at_sec"]) == ("b", "in", 45.0)
    assert "sits inside the right clip" in note["message"]
