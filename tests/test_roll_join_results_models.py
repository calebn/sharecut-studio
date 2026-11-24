from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import RollAppliedResult, RollUnchangedResult

KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "left_clip_id",
    "right_clip_id",
    "delta_sec",
    "left_source_end",
    "right_source_start",
]


def _roll(**over):
    base = {
        "operation": "roll_clip_join",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 4.0,
        "left_clip_id": "left",
        "right_clip_id": "right",
        "delta_sec": 0.25,
        "left_source_end": 5.25,
        "right_source_start": 5.25,
    }
    return {**base, **over}


def test_dump_key_order():
    assert list(RollAppliedResult(**_roll()).model_dump()) == KEYS


def test_dump_values():
    assert RollAppliedResult(**_roll()).model_dump() == _roll()


def test_timeline_duration_none_kept_as_null():
    dumped = RollAppliedResult(**_roll(timeline_duration_sec=None)).model_dump()
    assert list(dumped) == KEYS
    assert dumped["timeline_duration_sec"] is None


def test_frozen():
    result = RollAppliedResult(**_roll())
    with pytest.raises(ValidationError):
        result.delta_sec = 3.0


def test_extra_forbidden():
    with pytest.raises(ValidationError):
        RollAppliedResult(**_roll(extra_key=1))


def test_operation_literal_rejected():
    with pytest.raises(ValidationError):
        RollAppliedResult(**_roll(operation="other"))


@pytest.mark.parametrize("field", ["clip_count", "delta_sec", "left_clip_id"])
def test_wrong_type_rejected(field):
    with pytest.raises(ValidationError):
        RollAppliedResult(**_roll(**{field: [1]}))


@pytest.mark.parametrize("missing", KEYS)
def test_every_field_required(missing):
    data = _roll()
    del data[missing]
    with pytest.raises(ValidationError):
        RollAppliedResult(**data)


def test_unchanged_shape():
    result = RollUnchangedResult(operation="roll_clip_join", unchanged=True)
    assert result.model_dump() == {"operation": "roll_clip_join", "unchanged": True}
    assert list(result.model_dump()) == ["operation", "unchanged"]


def test_unchanged_rejects_false_and_extra_and_mutation():
    with pytest.raises(ValidationError):
        RollUnchangedResult(operation="roll_clip_join", unchanged=False)
    with pytest.raises(ValidationError):
        RollUnchangedResult(operation="roll_clip_join", unchanged=True, extra=1)
    result = RollUnchangedResult(operation="roll_clip_join", unchanged=True)
    with pytest.raises(ValidationError):
        result.unchanged = True
