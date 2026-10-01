"""Precision boundaries share source-safe limits and a stale-save guard."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.clips_ops import roll_join_limits, trim_edge_limits
from podcast_mcp.models import Clip, MediaAsset, SourceRecording, Track, TrackRole, load_project
from podcast_mcp.services.boundary import (
    RollBoundaryTarget,
    TrimBoundaryTarget,
    boundary_context,
)
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.workspace import ProjectWorkspace


def _project(path: Path) -> ProjectWorkspace:
    ws = ProjectWorkspace.open(path)
    ws.project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=100),
        )
    ]
    ws.project.sources = [
        SourceRecording(id="other", path="raw/other.wav", duration_sec=8),
        SourceRecording(id="alias", path="raw/host.wav", duration_sec=100),
        SourceRecording(id="unknown", path="raw/unknown.wav"),
    ]
    ws.project.clips = [
        Clip(id="left", track_id="host", source_start=2, source_end=5, timeline_start=0),
        Clip(
            id="right",
            track_id="host",
            source_id="other",
            source_start=1,
            source_end=6,
            timeline_start=3,
        ),
        Clip(
            id="last",
            track_id="host",
            source_id="alias",
            source_start=3,
            source_end=5,
            timeline_start=8,
        ),
    ]
    ws.save()
    return ws


def test_bounds_use_each_recording_clock_and_physical_alias(minimal_project: Path) -> None:
    p = _project(minimal_project).project
    left, right, last = p.clips
    assert trim_edge_limits(p, left, "out") == pytest.approx((2.05, 100))
    assert trim_edge_limits(p, right, "in") == pytest.approx((0, 5.95))
    assert trim_edge_limits(p, right, "out") == pytest.approx((1.05, 8))
    assert trim_edge_limits(p, last, "in") == pytest.approx((0, 4.95))
    assert roll_join_limits(p, "left", "right") == pytest.approx((-1, 4.95))
    p.clips[1] = right.model_copy(update={"source_id": "alias", "source_start": 6})
    assert trim_edge_limits(p, left, "out") == pytest.approx((2.05, 6))


def test_unknown_duration_abstains_from_expansion(minimal_project: Path) -> None:
    p = _project(minimal_project).project
    p.clips[0].source_id = "unknown"
    assert trim_edge_limits(p, p.clips[0], "out")[1] == 5
    assert roll_join_limits(p, "left", "right")[1] == 0


def test_visible_geometry_and_stale_apply_leave_history_untouched(
    minimal_project: Path,
) -> None:
    ws = _project(minimal_project)
    target = RollBoundaryTarget(left_clip_id="left", right_clip_id="right")
    original = boundary_context(ws.project, target)
    assert (
        boundary_context(ws.project, target, expected_geometry=original.geometry).token
        == original.token
    )
    with pytest.raises(DocumentConflictError):
        boundary_context(ws.project, target, expected_geometry=[])
    service = EditService(ws)
    history_before = len(ws.project.history.entries)
    assert service.roll_clip_join("left", "right", 0, expected_token=original.token)["unchanged"]
    assert len(load_project(minimal_project).history.entries) == history_before
    # A different edit lands after the editor opened. Apply validates after reload.
    other = ProjectWorkspace.open(minimal_project)
    other.project.clips[0].source_end = 5.25
    other.save()
    with pytest.raises(DocumentConflictError):
        service.roll_clip_join("left", "right", 0.25, expected_token=original.token)
    saved = load_project(minimal_project)
    assert saved.clips[0].source_end == 5.25
    assert len(saved.history.entries) == history_before


def test_token_changes_for_same_path_media_replacement(
    minimal_project: Path,
) -> None:
    ws = _project(minimal_project)
    target = TrimBoundaryTarget(clip_id="left", edge="out")
    media = ws.project.workspace_path() / "raw" / "host.wav"
    media.parent.mkdir(parents=True, exist_ok=True)
    media.write_bytes(b"one")
    first = boundary_context(ws.project, target).token
    media.write_bytes(b"longer replacement")
    assert boundary_context(ws.project, target).token != first


def test_document_noop_apply_does_not_add_history(minimal_project: Path) -> None:
    ws = _project(minimal_project)
    target = TrimBoundaryTarget(clip_id="left", edge="out")
    token = boundary_context(ws.project, target).token
    before = len(load_project(minimal_project).history.entries)
    result = DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(
            type="TrimClipEdge",
            payload={
                "clip_id": "left",
                "edge": "out",
                "source_sec": 5,
                "expected_token": token,
            },
            client_id="precision-test",
            role="viewer",
            client_seq=1,
        )
    )
    assert result["ok"]
    assert len(load_project(minimal_project).history.entries) == before
