from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import StripSilenceResult
from podcast_mcp.services.document.strip_silence_results import strip_silence_result

REPORT = {
    "track_id": "host",
    "silence_intervals": 2,
    "clips_created": 3,
    "removed_sec": 2.8000000000000007,
    "timeline_duration_sec": 6.0,
}


def test_field_order() -> None:
    assert list(StripSilenceResult.model_fields) == list(REPORT)


def test_frozen() -> None:
    with pytest.raises(ValidationError):
        strip_silence_result(REPORT).clips_created = 1


def test_extra_forbidden() -> None:
    with pytest.raises(ValidationError):
        strip_silence_result({**REPORT, "x": 1})


def test_missing_field_rejected() -> None:
    with pytest.raises(ValidationError):
        strip_silence_result({k: v for k, v in REPORT.items() if k != "removed_sec"})


def test_non_numeric_rejected() -> None:
    with pytest.raises(ValidationError):
        strip_silence_result({**REPORT, "removed_sec": "lots"})


def test_floats_and_text_round_trip() -> None:
    dumped = strip_silence_result(REPORT).model_dump()
    assert dumped == REPORT
    assert all(type(dumped[k]) is float for k in ("removed_sec", "timeline_duration_sec"))
    assert json.dumps(dumped, indent=2) == json.dumps(REPORT, indent=2)
