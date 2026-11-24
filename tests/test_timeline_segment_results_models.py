import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import DuplicateSegmentResult, PasteSegmentResult

BASE = {"affected_tracks": ["t"], "clip_count": 1, "timeline_duration_sec": 1.0}


def test_unknown_field_raises() -> None:
    with pytest.raises(ValidationError):
        DuplicateSegmentResult(operation="duplicate_segment", **BASE, extra=1)
    with pytest.raises(ValidationError):
        PasteSegmentResult(
            operation="paste_segment", **BASE, insert_at=1, duration=1, mode="gap", extra=1
        )


def test_wrong_operation_rejected() -> None:
    with pytest.raises(ValidationError):
        DuplicateSegmentResult(operation="paste_segment", **BASE)
    with pytest.raises(ValidationError):
        PasteSegmentResult(
            operation="duplicate_segment", **BASE, insert_at=1, duration=1, mode="gap"
        )


def test_int_stays_int() -> None:
    dumped = PasteSegmentResult(
        operation="paste_segment", **BASE, insert_at=2, duration=3, mode="ripple"
    ).model_dump()
    assert type(dumped["insert_at"]) is int
    assert type(dumped["duration"]) is int


def test_null_duration_ok() -> None:
    base = {**BASE, "timeline_duration_sec": None}
    assert (
        DuplicateSegmentResult(operation="duplicate_segment", **base).timeline_duration_sec is None
    )
    paste = PasteSegmentResult(
        operation="paste_segment", **base, insert_at=1.5, duration=2.5, mode="gap"
    )
    assert paste.model_dump()["timeline_duration_sec"] is None


def test_bad_mode_rejected() -> None:
    with pytest.raises(ValidationError):
        PasteSegmentResult(operation="paste_segment", **BASE, insert_at=1, duration=1, mode="x")
