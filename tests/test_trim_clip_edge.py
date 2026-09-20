"""Tests for trim_clip_edge domain op and TrimClipEdge document command."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.clips_ops import trim_clip_edge
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.services.workspace import ProjectWorkspace


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
    trim_clip_edge(project, "c1", "out", 12.0)
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
    trim_clip_edge(project, "c1", "out", 20.0)  # would invade c2 source
    c1 = next(c for c in project.clips if c.id == "c1")
    assert c1.source_end == 15.0


def test_trim_clip_edge_in_restores_cutaway(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_clips_with_cutaway(ws)
    project = ws.project
    trim_clip_edge(project, "c2", "in", 10.0)
    c2 = next(c for c in project.clips if c.id == "c2")
    assert c2.source_start == 10.0
    assert c2.timeline_start == pytest.approx(5.0)
    assert c2.timeline_end == pytest.approx(20.0)  # duration 15


def test_document_trim_clip_edge(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    _two_clips_with_cutaway(ws)
    svc = DocumentSyncService.open(minimal_project)
    out = svc.submit(
        DocumentCommand(
            type="TrimClipEdge",
            payload={
                "clip_id": "c1",
                "edge": "out",
                "source_sec": 10.0,
                "mode": "ripple",
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
