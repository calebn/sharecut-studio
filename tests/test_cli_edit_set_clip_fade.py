from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import Clip, FadeCurve, MediaAsset, Track, TrackRole, load_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync.registry import COMMANDS, named


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


@pytest.fixture
def project(minimal_project: Path) -> Path:
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=4.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0,
            source_end=2,
            timeline_start=0,
            fade_in_ms=30,
            fade_out_ms=50,
        ),
    ]
    ws.save()
    return minimal_project


def _run(project: Path, *args: str):
    return CliRunner().invoke(
        app, ["edit", "set-clip-fade", "--project", str(project), "--clip", "a", *args]
    )


def _clip(project: Path) -> Clip:
    return next(c for c in load_project(project).clips if c.id == "a")


def test_registry_declares_the_cli_spelling() -> None:
    assert COMMANDS["SetClipFade"].cli == named("podcast edit set-clip-fade")


def test_a_400_ms_dialogue_fade_is_accepted_and_reported(project: Path) -> None:
    done = _run(project, "--fade-in-ms", "400", "--fade-out-ms", "400")
    assert done.exit_code == 0, done.output
    out = json.loads(done.output)
    assert (out["fade_in_ms"], out["fade_out_ms"], out["clamped"]) == (400, 400, False)
    assert (_clip(project).fade_in_ms, _clip(project).fade_out_ms) == (400, 400)


def test_an_omitted_side_keeps_its_current_fade(project: Path) -> None:
    done = _run(project, "--fade-in-ms", "120")
    assert done.exit_code == 0, done.output
    assert (_clip(project).fade_in_ms, _clip(project).fade_out_ms) == (120, 50)


def test_the_clip_bound_clamps_and_says_so(project: Path) -> None:
    done = _run(project, "--fade-in-ms", "1500", "--fade-out-ms", "1500")
    assert done.exit_code == 0, done.output
    out = json.loads(done.output)
    assert out["clamped"] is True
    assert (out["fade_in_ms"], out["fade_out_ms"]) == (1500, 500)
    assert (_clip(project).fade_in_ms, _clip(project).fade_out_ms) == (1500, 500)


def test_curves_are_set_and_undoable(project: Path) -> None:
    done = _run(
        project,
        "--fade-in-ms",
        "200",
        "--fade-in-curve",
        "equal_power",
        "--fade-out-curve",
        "s",
    )
    assert done.exit_code == 0, done.output
    clip = _clip(project)
    assert (clip.fade_in_curve, clip.fade_out_curve) == (FadeCurve.EQUAL_POWER, FadeCurve.S)
    HistoryService(ProjectWorkspace.open(project)).undo()
    clip = _clip(project)
    assert (clip.fade_in_ms, clip.fade_in_curve) == (30, FadeCurve.LINEAR)


@pytest.mark.parametrize(
    "args",
    [[], ["--fade-in-ms", "-5"], ["--fade-in-curve", "bad"]],
    ids=["nothing-to-set", "negative", "unknown-curve"],
)
def test_bad_input_is_refused_without_a_change(project: Path, args: list[str]) -> None:
    assert _run(project, *args).exit_code != 0
    assert (_clip(project).fade_in_ms, _clip(project).fade_out_ms) == (30, 50)


def test_unknown_clip_is_a_coded_error(project: Path) -> None:
    done = CliRunner().invoke(
        app,
        ["edit", "set-clip-fade", "--project", str(project), "--clip", "nope", "--fade-in-ms", "5"],
    )
    assert done.exit_code != 0
