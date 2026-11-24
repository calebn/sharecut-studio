from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from podcast_mcp.services.document.split_results import (
    ProposeSplitResult,
    SplitAtTimeResult,
    SplitClipResult,
)

PIECE = {
    "track_id": "host",
    "original_clip_id": "h1",
    "left_clip_id": "h2",
    "right_clip_id": "h3",
}

COMMON = {
    "operation": "split_clips_at",
    "affected_tracks": ["host"],
    "clip_count": 3,
    "timeline_duration_sec": 4.0,
    "at_time": 0.5,
    "skipped_track_ids": [],
    "split_source_by_track": {"host": 0.5},
}


def _clip(**over):
    return SplitClipResult(**{**COMMON, "split_pieces": [PIECE], **over})


def _at(**over):
    return SplitAtTimeResult(
        **{**COMMON, "first_right_pieces": [{"track_id": "host", "clip_id": "h3"}], **over}
    )


def _propose(**over):
    return ProposeSplitResult(
        **{"operation": "propose_split", "edit": {"start": 0.5}, "edits": [{"start": 0.5}], **over}
    )


@pytest.mark.parametrize("make", [_clip, _at, _propose])
def test_frozen(make):
    model = make()
    with pytest.raises(ValidationError):
        model.operation = "x"


@pytest.mark.parametrize("make", [_clip, _at, _propose])
def test_extra_forbidden(make):
    with pytest.raises(ValidationError):
        make(unexpected=1)


def test_split_clip_key_order():
    assert list(_clip().model_dump()) == [
        "operation",
        "affected_tracks",
        "clip_count",
        "timeline_duration_sec",
        "at_time",
        "skipped_track_ids",
        "split_source_by_track",
        "split_pieces",
    ]


def test_split_at_time_key_order_without_split_times():
    assert list(_at().model_dump()) == [
        "operation",
        "affected_tracks",
        "clip_count",
        "timeline_duration_sec",
        "at_time",
        "skipped_track_ids",
        "split_source_by_track",
        "first_right_pieces",
    ]


def test_split_at_time_key_order_with_split_times():
    dumped = _at(split_times=[0.5, 1.0]).model_dump()
    assert list(dumped)[-2:] == ["split_times", "first_right_pieces"]
    assert dumped["split_times"] == [0.5, 1.0]


def test_propose_key_order():
    assert list(_propose().model_dump()) == ["operation", "edit", "edits"]


def test_literal_rejected():
    with pytest.raises(ValidationError):
        _clip(operation="propose_split")
    with pytest.raises(ValidationError):
        _at(operation="other")
    with pytest.raises(ValidationError):
        _propose(operation="split_clips_at")


def test_timeline_duration_none_accepted():
    assert _clip(timeline_duration_sec=None).model_dump()["timeline_duration_sec"] is None
    assert _at(timeline_duration_sec=None).timeline_duration_sec is None


def test_at_time_int_preserved():
    assert isinstance(_clip(at_time=1).model_dump()["at_time"], int)


def test_union_discrimination_by_operation():
    adapter = TypeAdapter(SplitAtTimeResult | ProposeSplitResult)
    assert isinstance(adapter.validate_python(_propose().model_dump()), ProposeSplitResult)
    assert isinstance(adapter.validate_python(_at().model_dump()), SplitAtTimeResult)
