"""Direct tests of the pad-record helpers the verdict key and the pause check share (#2483)."""

from __future__ import annotations

from typing import Any

import pytest

from podcast_mcp.edits.cut_placement import is_pad_record, pad_sample_well_formed
from podcast_mcp.models import AppliedEditRecord


def _record(operation: str = "remove", **params: Any) -> AppliedEditRecord:
    return AppliedEditRecord(id="r", applied_at="2026-01-01", operation=operation, params=params)


@pytest.mark.parametrize("operation", ["fill_with_room_tone", "insert_room_tone_pad"])
def test_a_pad_operation_is_a_pad_record(operation: str) -> None:
    assert is_pad_record(_record(operation))


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"replace_gap_sec": 0.001}, True),
        ({"replace_gap_sec": 1}, True),
        ({"replace_gap_sec": 0}, False),
        ({"replace_gap_sec": 0.0}, False),
        ({"replace_gap_sec": -0.5}, False),
        ({"replace_gap_sec": float("nan")}, False),
        ({"replace_gap_sec": float("inf")}, False),
        ({"replace_gap_sec": True}, False),
        ({"replace_gap_sec": "0.5"}, False),
        ({"replace_gap_sec": 0.5, "mute": True}, False),
        ({}, False),
    ],
)
def test_a_remove_is_a_pad_record_only_for_a_positive_finite_gap_that_is_not_a_mute(
    params: dict[str, Any], expected: bool
) -> None:
    assert is_pad_record(_record(**params)) is expected


def _sample(**over: Any) -> dict[str, Any]:
    return {"track_id": "host", "source_id": None, "source_start": 1.0, "source_end": 2.0} | over


@pytest.mark.parametrize(
    ("sample", "expected"),
    [
        (_sample(), True),
        (_sample(source_id="src"), True),
        (_sample(track_id=""), False),
        (_sample(track_id=None), False),
        (_sample(track_id=7), False),
        (_sample(source_id=""), False),
        (_sample(source_id=7), False),
        ({"track_id": "host"}, False),
        ("host", False),
        (None, False),
        (["host"], False),
    ],
)
def test_a_pad_sample_must_name_a_non_empty_track_and_a_none_or_non_empty_source(
    sample: object, expected: bool
) -> None:
    assert pad_sample_well_formed(sample) is expected
