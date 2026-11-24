from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import SetClipJoinResult, SetJoinModeResult

MODE_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "join_left_clip_id",
    "join_render_mode",
    "join_crossfade_ms",
    "join_crossfade_blocked",
]

JOIN_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "left_clip_id",
    "right_clip_id",
    "join_in_mode",
    "left_fade_out_ms",
    "right_fade_in_ms",
    "crossfade_ms",
    "crossfade_blocked",
]


def _mode(**over):
    base = {
        "operation": "set_clip_join_mode",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 4.0,
        "join_left_clip_id": "a",
        "join_render_mode": "fade",
        "join_crossfade_ms": 0,
        "join_crossfade_blocked": None,
    }
    return {**base, **over}


def _join(**over):
    base = {
        "operation": "set_clip_join",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 4.0,
        "left_clip_id": "a",
        "right_clip_id": "b",
        "join_in_mode": "fade",
        "left_fade_out_ms": 10,
        "right_fade_in_ms": 10,
        "crossfade_ms": 0,
        "crossfade_blocked": None,
    }
    return {**base, **over}


def test_mode_dump_key_order_and_nulls_without_borrow():
    dumped = SetJoinModeResult(**_mode(join_left_clip_id=None, join_render_mode=None)).model_dump()
    assert list(dumped) == MODE_KEYS
    assert dumped["join_left_clip_id"] is None
    assert dumped["join_render_mode"] is None
    assert dumped["join_crossfade_blocked"] is None


def test_mode_borrow_present_when_set():
    dumped = SetJoinModeResult(**_mode(join_borrow_sec=0.01)).model_dump()
    assert list(dumped) == [*MODE_KEYS, "join_borrow_sec"]
    assert dumped["join_borrow_sec"] == 0.01


def test_mode_borrow_zero_is_kept():
    assert SetJoinModeResult(**_mode(join_borrow_sec=0.0)).model_dump()["join_borrow_sec"] == 0.0


def test_mode_only_borrow_is_dropped():
    dumped = SetJoinModeResult(**_mode(timeline_duration_sec=None)).model_dump()
    assert "join_borrow_sec" not in dumped
    assert dumped["timeline_duration_sec"] is None


def test_join_dump_key_order():
    assert list(SetClipJoinResult(**_join()).model_dump()) == JOIN_KEYS


@pytest.mark.parametrize("model,make", [(SetJoinModeResult, _mode), (SetClipJoinResult, _join)])
def test_frozen(model, make):
    result = model(**make())
    with pytest.raises(ValidationError):
        result.clip_count = 3


@pytest.mark.parametrize("model,make", [(SetJoinModeResult, _mode), (SetClipJoinResult, _join)])
def test_extra_forbidden(model, make):
    with pytest.raises(ValidationError):
        model(**make(surprise=1))


@pytest.mark.parametrize("model,make", [(SetJoinModeResult, _mode), (SetClipJoinResult, _join)])
def test_operation_literal_rejected(model, make):
    with pytest.raises(ValidationError):
        model(**make(operation="other"))


def test_join_in_mode_literal_rejected():
    with pytest.raises(ValidationError):
        SetClipJoinResult(**_join(join_in_mode="wobble"))


@pytest.mark.parametrize("mode", ["fade", "crossfade", "cut"])
def test_join_in_mode_accepted(mode):
    assert SetClipJoinResult(**_join(join_in_mode=mode)).join_in_mode == mode


def test_timeline_duration_none_accepted():
    assert SetClipJoinResult(**_join(timeline_duration_sec=None)).timeline_duration_sec is None
