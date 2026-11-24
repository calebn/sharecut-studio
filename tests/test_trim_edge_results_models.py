from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import TrimAppliedResult, TrimHeldResult, TrimUnchangedResult

APPLIED_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "clip_id",
    "edge",
    "source_sec",
    "mode",
    "clip_ids",
]


def _applied(**over):
    base = {
        "operation": "trim_clip_edge",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 4.0,
        "clip_id": "a",
        "edge": "out",
        "source_sec": 6.0,
        "mode": "ripple",
        "clip_ids": ["a", "b"],
    }
    return {**base, **over}


def test_applied_dump_keeps_key_order_and_drops_unset_cut_speech():
    dumped = TrimAppliedResult(**_applied()).model_dump()
    assert list(dumped) == APPLIED_KEYS
    assert list(TrimAppliedResult(**_applied()).model_dump(mode="json")) == APPLIED_KEYS


def test_applied_keeps_cut_speech_last_and_unchanged():
    speech = {"tracks": [{"track_id": "guest", "start": 10.1, "end": 10.9}]}
    dumped = TrimAppliedResult(**_applied(cut_speech=speech)).model_dump(mode="json")
    assert list(dumped) == [*APPLIED_KEYS, "cut_speech"]
    assert dumped["cut_speech"] == speech


def test_applied_allows_null_duration_and_keeps_it():
    dumped = TrimAppliedResult(**_applied(timeline_duration_sec=None)).model_dump()
    assert dumped["timeline_duration_sec"] is None


def test_applied_rejects_unknown_keys_and_bad_values():
    with pytest.raises(ValidationError):
        TrimAppliedResult(**_applied(extra=1))
    with pytest.raises(ValidationError):
        TrimAppliedResult(**_applied(mode="slide"))
    with pytest.raises(ValidationError):
        TrimAppliedResult(**_applied(edge="mid"))


def test_applied_is_frozen():
    result = TrimAppliedResult(**_applied())
    with pytest.raises(ValidationError):
        result.clip_id = "z"


def test_unchanged_dump():
    out = TrimUnchangedResult(operation="trim_clip_edge", unchanged=True).model_dump()
    assert out == {"operation": "trim_clip_edge", "unchanged": True}
    with pytest.raises(ValidationError):
        TrimUnchangedResult(operation="trim_clip_edge", unchanged=False)


def test_held_dump_matches_the_confirmation_dict():
    held = {
        "operation": "trim_clip_edge",
        "unchanged": True,
        "needs_confirmation": {"status": "needs_confirmation", "speech": {"a": [1, 2]}},
        "apply_anyway": "go",
    }
    dumped = TrimHeldResult(**held).model_dump()
    assert dumped == held
    assert list(dumped) == list(held)
