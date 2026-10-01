from __future__ import annotations

import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from podcast_mcp.edits.clips_ops import roll_join_limits, trim_edge_limits
from podcast_mcp.models import (
    ArchivedTranscriptWord,
    Clip,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.boundary import (
    RollBoundaryTarget,
    TrimBoundaryTarget,
    boundary_context,
)
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import (
    RollClipJoinPayload,
    TrimClipEdgePayload,
)
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.services.edit import EditService


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
    missing = ws.project.model_copy(deep=True)
    missing.clips = [clip for clip in missing.clips if clip.id != "right"]
    with pytest.raises(DocumentConflictError):
        boundary_context(missing, target, expected_geometry=original.geometry)
    service = EditService(ws)
    history_before = len(ws.project.history.entries)
    assert service.roll_clip_join("left", "right", 0, expected_token=original.token)["unchanged"]
    assert len(load_project(minimal_project).history.entries) == history_before
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
    before = media.stat()
    media.write_bytes(b"two")
    os.utime(media, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert media.stat().st_size == before.st_size
    assert media.stat().st_mtime_ns == before.st_mtime_ns
    assert boundary_context(ws.project, target).token != first


def test_archived_word_change_invalidates_proposed_preview(minimal_project: Path) -> None:
    ws = _project(minimal_project)
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            archived_words=[
                ArchivedTranscriptWord(
                    ordinal=0,
                    word=TranscriptWord(text="restored", start=5.1, end=5.3),
                )
            ],
        )
    ]
    ws.save()
    target = TrimBoundaryTarget(clip_id="left", edge="out")
    first = boundary_context(ws.project, target).token
    ws.project.transcripts[0].archived_words[0].word.ignored = True
    ws.save()
    assert boundary_context(ws.project, target).token != first
    with pytest.raises(DocumentConflictError):
        EditService(ws).trim_clip_edge("left", "out", 5.2, expected_token=first)


def test_document_noop_apply_does_not_add_history(minimal_project: Path) -> None:
    ws = _project(minimal_project)
    target = TrimBoundaryTarget(clip_id="left", edge="out")
    token = boundary_context(ws.project, target).token
    before = len(load_project(minimal_project).history.entries)
    project_before = minimal_project.read_bytes()
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
    assert minimal_project.read_bytes() == project_before


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
def test_boundary_commands_refuse_nonfinite_positions(minimal_project: Path, bad: float) -> None:
    with pytest.raises(ValidationError):
        TrimClipEdgePayload(clip_id="c", edge="out", source_sec=bad, expected_token="revision")
    with pytest.raises(ValidationError):
        RollClipJoinPayload(
            left_clip_id="a", right_clip_id="b", delta_sec=bad, expected_token="revision"
        )
    service = EditService(_project(minimal_project))
    with pytest.raises(ValueError, match="finite"):
        service.trim_clip_edge("left", "out", bad, expected_token="invalid")
    with pytest.raises(ValueError, match="finite"):
        service.roll_clip_join("left", "right", bad, expected_token="invalid")


def test_boundary_commands_require_revision() -> None:
    with pytest.raises(ValidationError):
        TrimClipEdgePayload(clip_id="c", edge="out", source_sec=1.0)
    with pytest.raises(ValidationError):
        RollClipJoinPayload(left_clip_id="a", right_clip_id="b", delta_sec=0.1)
