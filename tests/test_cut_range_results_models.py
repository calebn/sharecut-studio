from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import cut_range_results as crr

pytestmark = pytest.mark.unscoped_ok

RIPPLE_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "timeline_start",
    "timeline_end",
    "track_ids",
    "use_inaudible_opt",
    "span_count",
    "per_track_source",
]
GAP_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "timeline_start",
    "timeline_end",
    "mode",
]
HELD_KEYS = ["operation", "unchanged", "needs_confirmation", "apply_anyway"]
TEXT_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "query",
    "use_inaudible_opt",
    "timeline_start",
    "timeline_end",
    "span_count",
    "per_track_source",
]


def _ripple(**over):
    data = {
        "operation": "ripple_delete",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 5.5,
        "timeline_start": 0,
        "timeline_end": 0.65,
        "track_ids": ["host"],
        "use_inaudible_opt": None,
        "span_count": 1,
        "per_track_source": {"host": [0.2, 0.65]},
    }
    return {**data, **over}


def _gap(**over):
    data = {
        "operation": "punch_delete",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 5.5,
        "timeline_start": 1,
        "timeline_end": 2.5,
        "mode": "gap",
    }
    return {**data, **over}


def _held(**over):
    data = {
        "operation": "ripple_delete",
        "unchanged": True,
        "needs_confirmation": {"message": "m"},
        "apply_anyway": "x",
    }
    return {**data, **over}


def _text(**over):
    data = {
        "operation": "ripple_delete_text",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 5.5,
        "query": "hello",
        "use_inaudible_opt": True,
        "timeline_start": 0.5,
        "timeline_end": 1.0,
        "span_count": 1,
        "per_track_source": {"host": [0.5, 1.0]},
    }
    return {**data, **over}


def test_ripple_dump_key_order_and_drops_unset_optionals():
    assert list(crr.CutRangeRippleApplied(**_ripple()).model_dump()) == RIPPLE_KEYS


def test_ripple_dump_keeps_present_optionals_last():
    out = crr.CutRangeRippleApplied(
        **_ripple(cut_speech={"a": 1}, join_quality={"risk": 0})
    ).model_dump()
    assert list(out) == [*RIPPLE_KEYS, "cut_speech", "join_quality"]
    assert out["join_quality"] == {"risk": 0}
    only_jq = crr.CutRangeRippleApplied(**_ripple(join_quality={"risk": 1})).model_dump()
    assert list(only_jq) == [*RIPPLE_KEYS, "join_quality"]


def test_ripple_dump_keeps_none_fields_that_are_not_optional():
    out = crr.CutRangeRippleApplied(
        **_ripple(use_inaudible_opt=None, timeline_duration_sec=None)
    ).model_dump()
    assert out["use_inaudible_opt"] is None
    assert out["timeline_duration_sec"] is None


def test_gap_held_text_key_order():
    assert list(crr.CutRangeGapApplied(**_gap()).model_dump()) == GAP_KEYS
    assert list(crr.CutRangeHeld(**_held()).model_dump()) == HELD_KEYS
    assert list(crr.RippleDeleteTextApplied(**_text()).model_dump()) == TEXT_KEYS
    held = crr.RippleDeleteTextHeld(**_held(operation="ripple_delete_text", query="q"))
    assert list(held.model_dump()) == [*HELD_KEYS, "query"]


def test_text_dump_drops_unset_cut_speech_and_keeps_present():
    assert "cut_speech" not in crr.RippleDeleteTextApplied(**_text()).model_dump()
    out = crr.RippleDeleteTextApplied(**_text(cut_speech={"a": 1})).model_dump()
    assert list(out) == [*TEXT_KEYS, "cut_speech"]


def test_int_timeline_bounds_stay_int():
    ripple = crr.CutRangeRippleApplied(**_ripple()).model_dump()
    assert type(ripple["timeline_start"]) is int
    assert type(ripple["timeline_end"]) is float
    gap = crr.CutRangeGapApplied(**_gap()).model_dump()
    assert type(gap["timeline_start"]) is int
    assert type(gap["timeline_end"]) is float


@pytest.mark.parametrize(
    "model, data",
    [
        (crr.CutRangeRippleApplied, _ripple),
        (crr.CutRangeGapApplied, _gap),
        (crr.CutRangeHeld, _held),
        (crr.RippleDeleteTextApplied, _text),
        (crr.RippleDeleteTextHeld, lambda **o: _held(query="q", **o)),
    ],
)
def test_extra_keys_are_rejected_and_models_are_frozen(model, data):
    with pytest.raises(ValidationError):
        model(**data(extra=1))
    instance = model(**data())
    with pytest.raises(ValidationError):
        instance.operation = "x"


def test_literals_reject_other_values():
    with pytest.raises(ValidationError):
        crr.CutRangeRippleApplied(**_ripple(operation="punch_delete"))
    with pytest.raises(ValidationError):
        crr.CutRangeGapApplied(**_gap(mode="ripple"))
    with pytest.raises(ValidationError):
        crr.CutRangeGapApplied(**_gap(operation="ripple_delete"))
    with pytest.raises(ValidationError):
        crr.CutRangeHeld(**_held(operation="punch_delete"))
    with pytest.raises(ValidationError):
        crr.CutRangeHeld(**_held(unchanged=False))
    with pytest.raises(ValidationError):
        crr.RippleDeleteTextApplied(**_text(operation="ripple_delete"))


def test_cut_range_builder_routes_each_shape():
    assert isinstance(crr.cut_range_result(_ripple()), crr.CutRangeRippleApplied)
    assert isinstance(crr.cut_range_result(_gap()), crr.CutRangeGapApplied)
    held = crr.cut_range_result(_held())
    assert type(held) is crr.CutRangeHeld
    assert held.needs_confirmation == {"message": "m"}


def test_ripple_delete_text_builder_routes_each_shape():
    applied = crr.ripple_delete_text_result(_text())
    assert isinstance(applied, crr.RippleDeleteTextApplied)
    held = crr.ripple_delete_text_result(_held(operation="ripple_delete_text", query="q"))
    assert isinstance(held, crr.RippleDeleteTextHeld)
    assert held.query == "q"


def test_builders_reject_unknown_keys():
    with pytest.raises(ValidationError):
        crr.cut_range_result(_ripple(extra=1))
    with pytest.raises(ValidationError):
        crr.ripple_delete_text_result(_text(extra=1))
