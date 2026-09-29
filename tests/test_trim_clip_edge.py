"""MCP / CLI adapters over EditService.trim_clip_edge (the speech_crosses_cut fix)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project

runner = CliRunner()


def _spliced_project(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60.0),
        )
    ]
    project.clips = [
        Clip(id="c0", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(id="c1", track_id="host", source_start=20.34, source_end=30.0, timeline_start=10.0),
        Clip(id="c2", track_id="host", source_start=40.0, source_end=45.0, timeline_start=19.66),
    ]
    save_project(project, minimal_project)
    return minimal_project


def test_trim_clip_edge_tool_restores_a_clipped_onset_and_ripples(minimal_project: Path) -> None:
    path = _spliced_project(minimal_project)
    out = json.loads(mcp_timeline.trim_clip_edge_tool(str(path), "c1", "in", 19.94))
    assert out["operation"] == "trim_clip_edge"
    project = load_project(path)
    clips = {c.id: c for c in project.clips}
    assert clips["c1"].source_start == 19.94
    assert clips["c1"].timeline_start == 10.0
    # The clip grew by 0.4 s, so the next clip on the track moved by the same amount.
    assert round(clips["c2"].timeline_start, 6) == 20.06


def test_trim_clip_edge_tool_is_undoable(minimal_project: Path) -> None:
    from podcast_mcp.services import HistoryService, ProjectWorkspace

    path = _spliced_project(minimal_project)
    mcp_timeline.trim_clip_edge_tool(str(path), "c0", "out", 9.5)
    assert load_project(path).clips[0].source_end == 9.5
    HistoryService(ProjectWorkspace.open(path)).undo(rerender=False)
    assert load_project(path).clips[0].source_end == 10.0


def test_cli_trim_clip(tmp_path: Path) -> None:
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    with patch("podcast_mcp.cli.edit.EditService") as service:
        service.return_value.trim_clip_edge.return_value = {"operation": "trim_clip_edge"}
        result = runner.invoke(
            app,
            [
                "edit",
                "trim-clip",
                "--project",
                str(ws / "episode.project.json"),
                "--clip",
                "c1",
                "--edge",
                "in",
                "--source-sec",
                "1575.55",
            ],
        )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["operation"] == "trim_clip_edge"
    service.return_value.trim_clip_edge.assert_called_once_with(
        "c1", "in", 1575.55, all_tracks=False
    )


def _session_ripple_project(minimal_project: Path) -> Path:
    """Three dialogue tracks that share one ripple join at timeline 10.0 s."""
    project = load_project(minimal_project)
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60.0),
        )
        for tid in ("host", "guest", "remote")
    ]
    project.clips = []
    for tid in ("host", "guest", "remote"):
        project.clips += [
            Clip(
                id=f"{tid}_a", track_id=tid, source_start=0.0, source_end=10.0, timeline_start=0.0
            ),
            Clip(
                id=f"{tid}_b",
                track_id=tid,
                source_start=20.34,
                source_end=30.0,
                timeline_start=10.0,
            ),
            Clip(
                id=f"{tid}_c",
                track_id=tid,
                source_start=40.0,
                source_end=45.0,
                timeline_start=19.66,
            ),
        ]
    save_project(project, minimal_project)
    return minimal_project


def test_trim_clip_edge_all_tracks_moves_the_session_join_on_every_track(
    minimal_project: Path,
) -> None:
    path = _session_ripple_project(minimal_project)
    out = json.loads(
        mcp_timeline.trim_clip_edge_tool(str(path), "remote_b", "in", 19.94, all_tracks=True)
    )
    assert out["all_tracks"] is True
    assert sorted(out["clip_ids"]) == ["guest_b", "host_b", "remote_b"]
    clips = {c.id: c for c in load_project(path).clips}
    for tid in ("host", "guest", "remote"):
        assert clips[f"{tid}_b"].source_start == pytest.approx(19.94)
        assert clips[f"{tid}_b"].timeline_start == 10.0
        assert clips[f"{tid}_c"].timeline_start == pytest.approx(20.06)


def test_trim_clip_edge_all_tracks_refuses_a_track_local_boundary(minimal_project: Path) -> None:
    path = _session_ripple_project(minimal_project)
    project = load_project(path)
    # A punch on one track: its later clip resumes where no other track has an edge.
    project.clips.append(
        Clip(id="host_d", track_id="host", source_start=50.0, source_end=52.0, timeline_start=30.0)
    )
    save_project(project, path)
    with pytest.raises(ValueError, match="track-local"):
        mcp_timeline.trim_clip_edge_tool(str(path), "host_d", "in", 49.5, all_tracks=True)
    assert load_project(path).clips[-1].source_start == 50.0


def test_cli_trim_clip_all_tracks(tmp_path: Path) -> None:
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    with patch("podcast_mcp.cli.edit.EditService") as service:
        service.return_value.trim_clip_edge.return_value = {"operation": "trim_clip_edge"}
        result = runner.invoke(
            app,
            [
                "edit",
                "trim-clip",
                "--project",
                str(ws / "episode.project.json"),
                "--clip",
                "c1",
                "--edge",
                "in",
                "--source-sec",
                "1575.55",
                "--all-tracks",
            ],
        )
    assert result.exit_code == 0, result.output
    service.return_value.trim_clip_edge.assert_called_once_with(
        "c1", "in", 1575.55, all_tracks=True
    )
