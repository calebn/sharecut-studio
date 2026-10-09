"""trim_clip_edge: the trim plan geometry, the TrimClipEdge document command, and the
MCP / CLI adapters over EditService.trim_clip_edge (the speech_crosses_cut fix).
Both edit modes and the speech guard are covered in ``test_edit_modes.py``."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    EditMode,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document.boundary import TrimBoundaryTarget, boundary_context
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import DocumentSyncService
from ripple_helpers import trim


def _two_clips_with_cutaway(ws: ProjectWorkspace) -> None:
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        )
    ]
    # Cutaway source 5..15 between clips; timeline abutting 0..5 and 5..15
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=15.0,
            source_end=25.0,
            timeline_start=5.0,
        ),
    ]
    ws.save()


def test_trim_clip_edge_out_expands_into_cutaway_and_ripples(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_clips_with_cutaway(ws)
    project = ws.project
    trim(project, "c1", "out", 12.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c1.source_end == 12.0
    assert c1.timeline_end == pytest.approx(12.0)
    assert c2.timeline_start == pytest.approx(12.0)
    assert c2.source_start == 15.0


def test_trim_clip_edge_out_clamps_to_next_source_start(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_clips_with_cutaway(ws)
    project = ws.project
    trim(project, "c1", "out", 20.0)  # would invade c2 source
    c1 = next(c for c in project.clips if c.id == "c1")
    assert c1.source_end == 15.0


def test_trim_clip_edge_in_restores_cutaway(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_clips_with_cutaway(ws)
    project = ws.project
    trim(project, "c2", "in", 10.0)
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c2.source_start == 10.0
    assert c2.timeline_start == pytest.approx(5.0)
    assert c2.timeline_end == pytest.approx(20.0)  # duration 15


def test_document_trim_clip_edge(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_clips_with_cutaway(ws)
    revision = boundary_context(ws.project, TrimBoundaryTarget(clip_id="c1", edge="out")).token
    svc = DocumentSyncService.open(minimal_project)
    out = svc.submit(
        DocumentCommand(
            type="TrimClipEdge",
            payload={
                "clip_id": "c1",
                "edge": "out",
                "source_sec": 10.0,
                "mode": "ripple",
                "expected_token": revision,
            },
            client_id="c1",
            role="viewer",
            client_seq=1,
        )
    )
    assert out["ok"]
    ws2 = ProjectWorkspace.open(minimal_project)
    c1 = next(c for c in ws2.project.clips if c.id == "c1")
    c2 = next(c for c in ws2.project.clips if c.id == "c2")
    assert c1.source_end == 10.0
    assert c2.timeline_start == pytest.approx(10.0)


def test_document_trim_preserves_a_follower_that_moves_before_zero(minimal_project):
    project = load_project(minimal_project)
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=30.0),
        )
    ]
    project.sources = [SourceRecording(id="alt", path="raw/alt.wav", duration_sec=30.0)]
    project.timeline.clips = [
        Clip(id="anchor", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(
            id="follower",
            track_id="host",
            source_id="alt",
            source_start=0.0,
            source_end=19.0,
            timeline_start=1.0,
            fade_in_ms=17,
            fade_out_ms=23,
            join_in_mode=ClipJoinMode.CROSSFADE,
            mute_regions=[ClipMuteRegion(start_s=2.0, end_s=3.0, fade_out_ms=2, fade_in_ms=4)],
        ),
    ]
    save_project(project)
    ws = ProjectWorkspace.open(minimal_project)
    token = boundary_context(
        ws.project,
        TrimBoundaryTarget(clip_id="anchor", edge="out", mode=EditMode.RIPPLE),
    ).token

    EditService(ws).trim_clip_edge(
        "anchor",
        "out",
        8.0,
        mode=EditMode.RIPPLE,
        expected_token=token,
        confirm_cut_speech=True,
    )

    saved = load_project(minimal_project)
    follower = next(clip for clip in saved.clips if clip.id == "follower")
    assert follower.timeline_start == -1.0
    assert (follower.source_start, follower.source_end, follower.source_id) == (0.0, 19.0, "alt")
    assert (follower.fade_in_ms, follower.fade_out_ms, follower.join_in_mode) == (
        17,
        23,
        ClipJoinMode.CROSSFADE,
    )
    assert follower.mute_regions == [
        ClipMuteRegion(start_s=2.0, end_s=3.0, fade_out_ms=2, fade_in_ms=4)
    ]


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
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import HistoryService

    path = _spliced_project(minimal_project)
    mcp_timeline.trim_clip_edge_tool(str(path), "c0", "out", 9.5)
    assert load_project(path).clips[0].source_end == 9.5
    HistoryService(ProjectWorkspace.open(path)).undo(rerender=False)
    assert load_project(path).clips[0].source_end == 10.0


def test_cli_trim_clip(tmp_path: Path) -> None:
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    with patch("podcast_mcp.cli.edit.EditService") as service:
        service.return_value.boundary_context.return_value.token = "current-revision"
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
        "c1",
        "in",
        1575.55,
        mode=EditMode.RIPPLE,
        expected_token="current-revision",
        confirm_cut_speech=False,
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


def test_ripple_trim_moves_the_session_join_on_every_track(
    minimal_project: Path,
) -> None:
    path = _session_ripple_project(minimal_project)
    out = json.loads(mcp_timeline.trim_clip_edge_tool(str(path), "remote_b", "in", 19.94))
    assert out["mode"] == "ripple"
    assert sorted(out["clip_ids"]) == ["guest_b", "host_b", "remote_b"]
    clips = {c.id: c for c in load_project(path).clips}
    for tid in ("host", "guest", "remote"):
        assert clips[f"{tid}_b"].source_start == pytest.approx(19.94)
        assert clips[f"{tid}_b"].timeline_start == 10.0
        assert clips[f"{tid}_c"].timeline_start == pytest.approx(20.06)


def test_zero_delta_ripple_trim_does_not_save_or_add_history(minimal_project: Path) -> None:
    path = _session_ripple_project(minimal_project)
    ws = ProjectWorkspace.open(path)
    revision = boundary_context(ws.project, TrimBoundaryTarget(clip_id="remote_b", edge="in")).token
    before = path.read_bytes()
    history = len(ws.project.history.entries)
    result = EditService(ws).trim_clip_edge(
        "remote_b", "in", 20.34, mode=EditMode.RIPPLE, expected_token=revision
    )
    assert result["unchanged"] is True
    assert path.read_bytes() == before
    assert len(load_project(path).history.entries) == history


def test_gap_trim_moves_only_a_track_local_edge(minimal_project: Path) -> None:
    path = _session_ripple_project(minimal_project)
    project = load_project(path)
    # A punch on one track: its later clip resumes where no other track has an edge.
    project.clips.append(
        Clip(id="host_d", track_id="host", source_start=50.0, source_end=52.0, timeline_start=30.0)
    )
    save_project(project, path)
    before = {c.id: c.timeline_start for c in load_project(path).clips if c.id != "host_d"}
    out = json.loads(mcp_timeline.trim_clip_edge_tool(str(path), "host_d", "in", 49.5, mode="gap"))
    assert out["clip_ids"] == ["host_d"]
    clips = {c.id: c for c in load_project(path).clips}
    assert (clips["host_d"].source_start, clips["host_d"].timeline_start) == (49.5, 29.5)
    assert {cid: clips[cid].timeline_start for cid in before} == before


def test_cli_trim_clip_gap_mode(tmp_path: Path) -> None:
    ws = tmp_path / "ep"
    runner.invoke(app, ["episode", "init", "--dir", str(ws)])
    with patch("podcast_mcp.cli.edit.EditService") as service:
        service.return_value.boundary_context.return_value.token = "current-revision"
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
                "--mode",
                "gap",
            ],
        )
    assert result.exit_code == 0, result.output
    service.return_value.trim_clip_edge.assert_called_once_with(
        "c1",
        "in",
        1575.55,
        mode=EditMode.GAP,
        expected_token="current-revision",
        confirm_cut_speech=False,
    )


def test_a_peer_that_cannot_reveal_as_much_gets_silence_and_stays_in_sync(
    minimal_project: Path,
) -> None:
    """A punch-in clip on host ends 140 ms before the join, so host cannot reveal the
    400 ms the others do: host gets 400 ms of silence there instead, and every track
    still moves the same amount."""
    path = _session_ripple_project(minimal_project)
    project = load_project(path)
    project.clips.append(
        Clip(id="host_p", track_id="host", source_start=19.7, source_end=20.2, timeline_start=9.5)
    )
    save_project(project, path)
    out = json.loads(mcp_timeline.trim_clip_edge_tool(str(path), "remote_b", "in", 19.94))
    assert sorted(out["clip_ids"]) == ["guest_b", "remote_b"]
    clips = {c.id: c for c in load_project(path).clips}
    assert [clips[f"{tid}_b"].source_start for tid in ("host", "guest", "remote")] == [
        20.34,
        19.94,
        19.94,
    ]
    assert round(clips["host_b"].timeline_start, 6) == 10.4
    assert [round(clips[f"{tid}_c"].timeline_start, 6) for tid in ("host", "guest", "remote")] == [
        20.06
    ] * 3
