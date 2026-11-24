from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import SetClipFadeResult

KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "fade_in_ms",
    "fade_out_ms",
    "clamped",
]


def _fade(**over):
    base = {
        "operation": "set_clip_fade",
        "affected_tracks": ["host"],
        "clip_count": 1,
        "timeline_duration_sec": 4.0,
        "fade_in_ms": 100,
        "fade_out_ms": 200,
        "clamped": False,
    }
    return {**base, **over}


def test_dump_key_order():
    assert list(SetClipFadeResult(**_fade()).model_dump()) == KEYS


def test_dump_values():
    assert SetClipFadeResult(**_fade()).model_dump() == _fade()


def test_timeline_duration_none_kept_as_null():
    dumped = SetClipFadeResult(**_fade(timeline_duration_sec=None)).model_dump()
    assert list(dumped) == KEYS
    assert dumped["timeline_duration_sec"] is None


def test_frozen():
    result = SetClipFadeResult(**_fade())
    with pytest.raises(ValidationError):
        result.fade_in_ms = 3


def test_extra_forbidden():
    with pytest.raises(ValidationError):
        SetClipFadeResult(**_fade(fade_in_curve="s"))


def test_operation_literal_rejected():
    with pytest.raises(ValidationError):
        SetClipFadeResult(**_fade(operation="other"))


@pytest.mark.parametrize("missing", KEYS)
def test_every_field_required(missing):
    data = _fade()
    del data[missing]
    with pytest.raises(ValidationError):
        SetClipFadeResult(**data)
