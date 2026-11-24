import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import InsertGapResult, MoveClipsResult, MoveSegmentResult

BASE = {"affected_tracks": ["t"], "clip_count": 1, "timeline_duration_sec": 1.0}


def test_unknown_field_raises() -> None:
    with pytest.raises(ValidationError):
        InsertGapResult(operation="insert_gap", **BASE, at_time=1, duration_sec=1, extra=1)
    with pytest.raises(ValidationError):
        MoveSegmentResult(
            operation="move_segment", **BASE, source_start=0, source_end=1, insert_at=2, extra=1
        )
    with pytest.raises(ValidationError):
        MoveClipsResult(operation="move_clips", **BASE, clip_ids=["a"], extra=1)


def test_wrong_operation_rejected() -> None:
    with pytest.raises(ValidationError):
        InsertGapResult(operation="move_clips", **BASE, at_time=1, duration_sec=1)
    with pytest.raises(ValidationError):
        MoveSegmentResult(operation="insert_gap", **BASE, source_start=0, source_end=1, insert_at=2)
    with pytest.raises(ValidationError):
        MoveClipsResult(operation="move_segment", **BASE, clip_ids=[])


def test_int_stays_int() -> None:
    gap = InsertGapResult(operation="insert_gap", **BASE, at_time=2, duration_sec=1)
    assert type(gap.model_dump()["at_time"]) is int
    seg = MoveSegmentResult(
        operation="move_segment", **BASE, source_start=0, source_end=2, insert_at=8
    )
    dumped = seg.model_dump()
    assert all(type(dumped[k]) is int for k in ("source_start", "source_end", "insert_at"))
    assert MoveClipsResult(operation="move_clips", **BASE, clip_ids=["a"]).clip_count == 1


@pytest.mark.unscoped_ok
def test_empty_project_duration_is_none(minimal_project) -> None:
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import TimelineService

    ws = ProjectWorkspace.open(minimal_project)
    assert not ws.project.clips
    result = TimelineService(ws).insert_gap(0.0, 1.0)
    assert result.timeline_duration_sec is None
    assert result.model_dump()["timeline_duration_sec"] is None
