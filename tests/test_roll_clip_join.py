"""Tests for roll_clip_join domain op and RollClipJoin document command."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.clips_ops import roll_clip_join
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.services.workspace import ProjectWorkspace


def _three_clips(ws: ProjectWorkspace) -> None:
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    # Cutaway 5..15 between c1/c2; c3 after c2 on timeline
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
        Clip(
            id="c3",
            track_id="host",
            source_start=30.0,
            source_end=40.0,
            timeline_start=15.0,
        ),
    ]
    ws.save()


def test_roll_clip_join_moves_both_edges_and_stays_flush(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    project = ws.project
    roll_clip_join(project, "c1", "c2", 2.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    c3 = next(c for c in project.clips if c.id == "c3")
    assert c1.source_end == pytest.approx(7.0)
    assert c2.source_start == pytest.approx(17.0)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)
    # Cutaway gap preserved (10s)
    assert c2.source_start - c1.source_end == pytest.approx(10.0)
    # Pair duration unchanged → c3 unmoved
    assert c3.timeline_start == pytest.approx(15.0)
    assert c3.source_start == pytest.approx(30.0)


def test_roll_clip_join_negative_delta(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    project = ws.project
    roll_clip_join(project, "c1", "c2", -1.5)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    c3 = next(c for c in project.clips if c.id == "c3")
    assert c1.source_end == pytest.approx(3.5)
    assert c2.source_start == pytest.approx(13.5)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)
    assert c3.timeline_start == pytest.approx(15.0)


def test_roll_clip_join_clamps_to_min_span(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    project = ws.project
    # Would shrink c1 below min span
    roll_clip_join(project, "c1", "c2", -100.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c1.source_end - c1.source_start == pytest.approx(0.05)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)


def test_roll_cannot_eat_past_short_right_clip(minimal_project):
    """Join later is limited by right clip duration (e.g. only 2s of content)."""
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=12.0,  # only 2s of content
            timeline_start=10.0,
        ),
    ]
    ws.save()
    project = ws.project
    roll_clip_join(project, "c1", "c2", 100.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    # Right kept min span; join moved by ~1.95s not 100s
    assert c2.source_end - c2.source_start == pytest.approx(0.05)
    assert c1.source_end == pytest.approx(11.95)
    assert c2.source_start == pytest.approx(11.95)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)


def test_roll_cannot_eat_past_short_left_clip(minimal_project):
    """Join earlier is limited by left clip duration."""
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=80.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=8.0,
            source_end=10.0,  # only 2s of content
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=10.0,
            source_end=30.0,
            timeline_start=2.0,
        ),
    ]
    ws.save()
    project = ws.project
    roll_clip_join(project, "c1", "c2", -100.0)
    c1 = next(c for c in project.clips if c.id == "c1")
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c1.source_end - c1.source_start == pytest.approx(0.05)
    assert c1.source_end == pytest.approx(8.05)
    assert c2.source_start == pytest.approx(8.05)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)


def test_document_roll_clip_join(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _three_clips(ws)
    svc = DocumentSyncService.open(minimal_project)
    out = svc.submit(
        DocumentCommand(
            type="RollClipJoin",
            payload={
                "left_clip_id": "c1",
                "right_clip_id": "c2",
                "delta_sec": 1.0,
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
    c3 = next(c for c in ws2.project.clips if c.id == "c3")
    assert c1.source_end == pytest.approx(6.0)
    assert c2.source_start == pytest.approx(16.0)
    assert c2.timeline_start == pytest.approx(c1.timeline_end)
    assert c3.timeline_start == pytest.approx(15.0)
