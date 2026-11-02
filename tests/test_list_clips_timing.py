"""``list_clips`` rows of a clip with a timing map: counts, summary and the opt-in step list (#2862, 6a)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import DEFAULT_MICRO_FADE_MS, load_defaults
from podcast_mcp.edits.timeline_ops import list_clips
from podcast_mcp.mcp.tools.timeline import list_clips_tool
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document.timeline import TimelineService

SECRET = bytes(range(32))
GOLDEN = Path(__file__).parent / "fixtures" / "list_clips_untimed_golden.json"
_STEPS = [
    {"at": 20, "delta_sec": 0.12},
    {"at": 30, "delta_sec": -0.08, "quiet": {"start_s": 29, "end_s": 32}},
]


def _clips(timed: bool) -> list[Clip]:
    extra = {"timing": {"steps": _STEPS, "evidence": "private"}} if timed else {}
    return [
        Clip(id="a", track_id="host", source_start=10, source_end=40, timeline_start=100, **extra),
        Clip(id="b", track_id="host", source_start=50, source_end=60, timeline_start=200),
    ]


def _project(clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject.create("rows", "/tmp/rows")
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=600.0),
        )
    ]
    project.timeline.clips = clips
    return project


def _rows(project: EpisodeProject, **kw) -> dict[str, dict]:
    lane = list_clips(project, secret=SECRET, **kw)["tracks"]["host"]
    return {row["id"]: row for row in lane}


def test_untimed_rows_are_byte_identical_to_before_timing_columns() -> None:
    got = json.dumps(list_clips(_project(_clips(False)), secret=SECRET), indent=2, sort_keys=True)
    assert got == GOLDEN.read_text().rstrip("\n")
    flagged = list_clips(_project(_clips(False)), secret=SECRET, include_timing_steps=True)
    assert json.dumps(flagged, indent=2, sort_keys=True) == got


def test_timed_row_has_count_and_summary_but_no_steps_by_default() -> None:
    rows = _rows(_project(_clips(True)))
    assert rows["a"]["timing_steps"] == 2
    assert rows["a"]["timing_summary"] == "2 corrections, largest 120 ms"
    assert "timing" not in rows["a"]
    assert not {"timing_steps", "timing_summary", "timing"} & rows["b"].keys()


def test_a_single_step_reads_as_one_correction() -> None:
    clip = Clip(
        id="a",
        track_id="host",
        source_start=10,
        source_end=40,
        timeline_start=100,
        timing={"steps": _STEPS[:1]},
    )
    row = _rows(_project([clip]))["a"]
    assert row["timing_steps"] == 1
    assert row["timing_summary"] == "1 correction"


def test_timing_steps_flag_adds_the_step_list_without_quiet_or_evidence() -> None:
    row = _rows(_project(_clips(True)), include_timing_steps=True)["a"]
    assert row["timing"] == {
        "steps": [{"at": 20, "delta_sec": 0.12}, {"at": 30, "delta_sec": -0.08}],
        "method": "bleed_lag",
        "micro_fade_ms": DEFAULT_MICRO_FADE_MS,
    }
    assert "private" not in json.dumps(row)


@pytest.fixture
def timed_project(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60.0),
        )
    ]
    project.timeline.clips = _clips(True)
    save_project(project, minimal_project)
    return minimal_project


def test_service_reads_micro_fade_from_the_project_config(timed_project: Path) -> None:
    svc = TimelineService(ProjectWorkspace.open(timed_project))
    row = svc.list_clips(include_timing_steps=True)["tracks"]["host"][0]
    assert row["timing"]["micro_fade_ms"] == DEFAULT_MICRO_FADE_MS
    assert "timing" not in svc.list_clips()["tracks"]["host"][0]


def test_mcp_tool_steps_are_opt_in(timed_project: Path) -> None:
    plain = json.loads(list_clips_tool(str(timed_project)))["tracks"]["host"][0]
    full = json.loads(list_clips_tool(str(timed_project), include_timing_steps=True))["tracks"][
        "host"
    ][0]
    assert plain["timing_summary"] == "2 corrections, largest 120 ms"
    assert "timing" not in plain
    assert len(full["timing"]["steps"]) == 2


def test_cli_flag_adds_the_step_list(timed_project: Path) -> None:
    runner = CliRunner()
    base = ["edit", "list-clips", "--project", str(timed_project)]
    plain = runner.invoke(app, base)
    flagged = runner.invoke(app, [*base, "--timing-steps"])
    assert plain.exit_code == 0 and flagged.exit_code == 0
    assert "timing" not in json.loads(plain.stdout)["tracks"]["host"][0]
    assert json.loads(flagged.stdout)["tracks"]["host"][0]["timing"]["steps"][0]["at"] == 20


def test_gui_view_clips_carry_the_step_list(timed_project: Path) -> None:
    from podcast_mcp.gui.assembler import build_project_view

    view = build_project_view(ProjectWorkspace.open(timed_project))
    row = view.clips["tracks"]["host"][0]
    assert row["timing"]["steps"][1] == {"at": 30, "delta_sec": -0.08}


def test_service_passes_the_configured_micro_fade_to_the_payload(
    timed_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = {**load_defaults(), "inaudible_cuts": {"micro_fade_ms": 7}}
    monkeypatch.setattr(ProjectWorkspace, "effective_config", lambda self: config)
    svc = TimelineService(ProjectWorkspace.open(timed_project))
    assert (
        svc.list_clips(include_timing_steps=True)["tracks"]["host"][0]["timing"]["micro_fade_ms"]
        == 7
    )


def _first_row(payload: dict) -> dict:
    return payload["clips"]["tracks"]["host"][0]


@pytest.mark.parametrize("projection", ["clips", "transcript_audio"])
def test_gui_patches_carry_the_step_list_for_the_host(timed_project: Path, projection: str) -> None:
    from podcast_mcp.gui.assembler import dump_project_projection

    row = _first_row(dump_project_projection(timed_project, projection=projection))
    assert row["timing"]["steps"][0] == {"at": 20, "delta_sec": 0.12}


@pytest.mark.parametrize("projection", ["clips", "transcript_audio", "full"])
def test_guest_payloads_keep_the_summary_but_not_the_step_list(
    timed_project: Path, projection: str
) -> None:
    from podcast_mcp.gui.assembler import dump_project_projection

    payload = dump_project_projection(timed_project, projection=projection, audience="guest")
    row = _first_row(payload)
    assert row["timing_summary"] == "2 corrections, largest 120 ms"
    assert row["timing_steps"] == 2
    assert "timing" not in row
