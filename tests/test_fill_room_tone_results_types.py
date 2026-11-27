import pytest
from pydantic import TypeAdapter, ValidationError

from podcast_mcp.services.document.fill_room_tone_results import (
    FillRoomToneApplied,
    FillRoomToneUnchanged,
)

pytestmark = pytest.mark.unscoped_ok

APPLIED = {
    "operation": "fill_with_room_tone",
    "affected_tracks": ["host"],
    "clip_count": 4,
    "timeline_duration_sec": 6.25,
    "pad_samples": [
        {
            "track_id": "host",
            "source_id": "room-tone-host",
            "source_start": 0.0,
            "source_end": 0.25,
        },
        {"track_id": "host", "source_id": None, "source_start": 0.35, "source_end": 0.45},
    ],
}
UNCHANGED = {
    "operation": "fill_with_room_tone",
    "affected_tracks": ["host"],
    "clip_count": 1,
    "timeline_duration_sec": None,
    "pad_samples": [],
    "unchanged": True,
}


@pytest.mark.parametrize(
    ("model", "payload"), [(FillRoomToneApplied, APPLIED), (FillRoomToneUnchanged, UNCHANGED)]
)
def test_round_trip_preserves_values_and_key_order(model, payload) -> None:
    for parsed in (model.model_validate(payload), TypeAdapter(model).validate_python(payload)):
        dumped = parsed.model_dump()
        assert dumped == payload
        assert list(dumped) == list(payload)
        assert [list(sample) for sample in dumped["pad_samples"]] == [
            list(sample) for sample in payload["pad_samples"]
        ]


@pytest.mark.parametrize(
    ("model", "payload"), [(FillRoomToneApplied, APPLIED), (FillRoomToneUnchanged, UNCHANGED)]
)
def test_extra_key_is_rejected(model, payload) -> None:
    with pytest.raises(ValidationError):
        model.model_validate({**payload, "filled_sec": 0.5})


def test_applied_has_no_unchanged_field() -> None:
    assert "unchanged" not in FillRoomToneApplied.model_fields
    assert not hasattr(FillRoomToneApplied.model_validate(APPLIED), "unchanged")
    with pytest.raises(ValidationError):
        FillRoomToneApplied.model_validate(UNCHANGED)
