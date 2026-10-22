from copy import deepcopy

import pytest
from pydantic import ValidationError

from podcast_mcp.services.media import (
    GeneratingWaveformEntry,
    ReadyWaveformEntry,
    UnavailableWaveformEntry,
    WaveformLevel,
    WaveformStatusResult,
)


@pytest.fixture
def ready_payload():
    return {
        "status": "ready",
        "key": "0" * 20,
        "sample_rate": 8000,
        "channels": 1,
        "total_frames": 64,
        "base_spp": 64,
        "level_factor": 4,
        "bins_per_tile": 4096,
        "levels": [{"spp": 64, "bins": 1}],
    }


def test_waveform_result_round_trip_retains_each_state_shape(ready_payload):
    payload = {
        "format_version": 1,
        "media": {
            "source:missing": {"status": "unavailable", "reason": "no-media"},
            "track:building": {"status": "generating"},
            "track:ready": ready_payload,
        },
    }
    result = WaveformStatusResult.model_validate(payload)
    assert result.media == {
        "source:missing": UnavailableWaveformEntry(reason="no-media"),
        "track:building": GeneratingWaveformEntry(),
        "track:ready": ReadyWaveformEntry(
            key="0" * 20,
            sample_rate=8000,
            channels=1,
            total_frames=64,
            base_spp=64,
            level_factor=4,
            bins_per_tile=4096,
            levels=[WaveformLevel(spp=64, bins=1)],
        ),
    }
    assert result.model_dump(mode="json") == payload
    assert list(result.media) == list(payload["media"])
    assert list(result.model_dump(mode="json")) == ["format_version", "media"]


@pytest.mark.parametrize(
    ("entry", "error"),
    [
        ({"status": "ready"}, "missing"),
        ({"status": "generating", "key": "key"}, "extra_forbidden"),
        ({"status": "generating", "reason": "no-media"}, "extra_forbidden"),
        ({"status": "unavailable"}, "missing"),
        ({"status": "unavailable", "reason": "no-media", "key": "key"}, "extra_forbidden"),
        ({"status": "unknown"}, "union_tag_invalid"),
    ],
)
def test_waveform_result_rejects_incomplete_or_mixed_states(entry, error):
    with pytest.raises(ValidationError) as exc:
        WaveformStatusResult.model_validate({"format_version": 1, "media": {"track:host": entry}})
    assert error in {item["type"] for item in exc.value.errors()}


def test_waveform_ready_result_requires_complete_levels_and_no_reason(ready_payload):
    missing_bins = deepcopy(ready_payload)
    del missing_bins["levels"][0]["bins"]
    with pytest.raises(ValidationError) as exc:
        ReadyWaveformEntry.model_validate(missing_bins)
    assert exc.value.errors()[0]["loc"] == ("levels", 0, "bins")
    with pytest.raises(ValidationError) as exc:
        ReadyWaveformEntry.model_validate({**ready_payload, "reason": "no-media"})
    assert exc.value.errors()[0]["type"] == "extra_forbidden"


def test_waveform_entry_cannot_change_its_validated_state(ready_payload):
    payload = {"format_version": 1, "media": {"track:host": ready_payload}}
    result = WaveformStatusResult.model_validate(payload)
    entry = result.media["track:host"]
    with pytest.raises(ValidationError) as exc:
        entry.status = "generating"
    assert exc.value.errors()[0]["type"] == "frozen_instance"
    assert result.model_dump(mode="json") == payload
