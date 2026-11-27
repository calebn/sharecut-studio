from __future__ import annotations

import json

import pytest

from pause_policy_public_helpers import configure, defaults
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.timeline_ops import fill_with_room_tone
from podcast_mcp.models import load_project
from podcast_mcp.util.coded_error import CodedError
from test_fill_room_tone_wire_fixtures import (
    BED_PAD,
    LAYERS,
    OWN_PAD,
    WIRE_KEYS,
    digital_guest_path,
    gappy_path,
    no_clip_path,
    no_media_path,
    single_clip_path,
    twin_speaker_path,
)

pytestmark = pytest.mark.unscoped_ok


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def _wire(reply: dict) -> str:
    return json.dumps(reply, sort_keys=True)


def _expected(clip_count: int, pads: list[dict], **extra) -> str:
    return _wire(
        {
            "operation": "fill_with_room_tone",
            "affected_tracks": ["host"],
            "clip_count": clip_count,
            "timeline_duration_sec": 6.0,
            "pad_samples": pads,
            **extra,
        }
    )


@pytest.mark.parametrize("layer", LAYERS)
def test_whole_track_fill_with_a_bed_pins_the_reply(tmp_path, layer):
    reply = LAYERS[layer](gappy_path(tmp_path, "ws"), track_id="host")
    assert list(reply) == WIRE_KEYS
    assert _wire(reply) == _expected(6, [BED_PAD] * 4)
    assert [list(pad) for pad in reply["pad_samples"]] == [
        ["track_id", "source_id", "source_start", "source_end"]
    ] * 4


@pytest.mark.parametrize("layer", LAYERS)
def test_whole_track_fill_by_speaker_pins_the_same_reply(tmp_path, layer):
    reply = LAYERS[layer](gappy_path(tmp_path, "ws"), speaker="Host")
    assert list(reply) == WIRE_KEYS
    assert _wire(reply) == _expected(6, [BED_PAD] * 4)


@pytest.mark.parametrize("layer", LAYERS)
def test_whole_track_fill_with_no_bed_uses_the_tracks_own_quiet_sample(tmp_path, layer):
    reply = LAYERS[layer](gappy_path(tmp_path, "ws", bed=False), track_id="host")
    assert list(reply) == WIRE_KEYS
    assert _wire(reply) == _expected(6, [OWN_PAD] * 4)
    assert {pad["source_id"] for pad in reply["pad_samples"]} == {None}


@pytest.mark.parametrize("layer", LAYERS)
def test_range_fill_pins_the_reply(tmp_path, layer):
    reply = LAYERS[layer](gappy_path(tmp_path, "ws"), track_id="host", start_sec=0.5, end_sec=1.5)
    assert list(reply) == WIRE_KEYS
    assert _wire(reply) == _expected(4, [BED_PAD] * 2)


@pytest.mark.parametrize("layer", LAYERS)
def test_range_fill_with_no_bed_uses_the_tracks_own_quiet_sample(tmp_path, layer):
    reply = LAYERS[layer](
        gappy_path(tmp_path, "ws", bed=False), track_id="host", start_sec=0.5, end_sec=1.5
    )
    assert list(reply) == WIRE_KEYS
    assert _wire(reply) == _expected(4, [OWN_PAD] * 2)


@pytest.mark.parametrize("layer", LAYERS)
def test_a_single_clip_track_replies_unchanged_after_the_service_early_return(tmp_path, layer):
    path = single_clip_path(tmp_path)
    before = load_project(path).model_dump_json()
    reply = LAYERS[layer](path, track_id="host")
    assert list(reply) == [*WIRE_KEYS[:4], "pad_samples", "unchanged"]
    assert _wire(reply) == _expected(1, [], unchanged=True)
    assert load_project(path).model_dump_json() == before


@pytest.mark.parametrize("layer", LAYERS)
def test_a_track_with_no_clips_replies_unchanged_with_zero_clips(tmp_path, layer):
    reply = LAYERS[layer](no_clip_path(tmp_path), track_id="host")
    assert list(reply) == [*WIRE_KEYS, "unchanged"]
    assert _wire(reply) == _expected(0, [], unchanged=True)


@pytest.mark.parametrize("layer", LAYERS)
def test_the_unchanged_early_return_resolves_a_speaker(tmp_path, layer):
    path = single_clip_path(tmp_path)
    reply = LAYERS[layer](path, speaker="Host")
    assert _wire(reply) == _expected(1, [], unchanged=True)


def test_the_engine_early_return_has_no_unchanged_key(tmp_path):
    result = load_project(single_clip_path(tmp_path))
    reply = fill_with_room_tone(result, "host", defaults=load_defaults())
    assert list(reply) == WIRE_KEYS
    assert _wire(reply) == _expected(1, [])


def test_the_engine_early_return_with_no_clips_pins_the_reply(tmp_path):
    result = load_project(no_clip_path(tmp_path))
    reply = fill_with_room_tone(result, "host", defaults=load_defaults())
    assert _wire(reply) == _expected(0, [])


def _error(call, *args, **kwargs) -> tuple[str, str, str]:
    with pytest.raises(CodedError) as raised:
        call(*args, **kwargs)
    return type(raised.value).__name__, raised.value.code, str(raised.value)


NOTHING = ("nothing_to_fill", "no gap to fill in that range")
NO_SOURCE = ("no_source", "no room tone available (digital_silence)")
NO_MEDIA = ("track_has_no_media", "track ghost has no media")
UNKNOWN_TRACK = ("track_not_found", "unknown track_id: 'nope'")
UNKNOWN_SPEAKER = (
    "track_not_found",
    "no track for speaker 'Nobody'; available: host (Host)",
)
AMBIGUOUS = ("ambiguous_speaker", "ambiguous speaker 'host'; matches: host, guest")

CASES = {
    "single_range": (
        single_clip_path,
        {"track_id": "host", "start_sec": 1.0, "end_sec": 2.0},
        NOTHING,
        False,
    ),
    "clips_only": (
        gappy_path,
        {"track_id": "host", "start_sec": 0.1, "end_sec": 0.9},
        NOTHING,
        False,
    ),
    "no_source": (
        digital_guest_path,
        {"track_id": "guest", "start_sec": 1.0, "end_sec": 2.0},
        NO_SOURCE,
        False,
    ),
    "no_media": (no_media_path, {"track_id": "ghost"}, NO_MEDIA, True),
    "unknown_track": (gappy_path, {"track_id": "nope"}, UNKNOWN_TRACK, True),
    "unknown_speaker": (gappy_path, {"speaker": "Nobody"}, UNKNOWN_SPEAKER, True),
    "ambiguous": (twin_speaker_path, {"speaker": "host"}, AMBIGUOUS, False),
}


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("layer", LAYERS)
def test_error_codes_and_messages_are_pinned(tmp_path, layer, case):
    build, kwargs, expected, conflict_on_wire = CASES[case]
    path = build(tmp_path, "ws")
    name, code, message = _error(LAYERS[layer], path, **kwargs)
    assert (code, message) == expected
    wrapped = conflict_on_wire and layer in {"command", "tool"}
    assert name == ("DocumentConflictError" if wrapped else "CodedValueError")


@pytest.mark.parametrize("layer", LAYERS)
def test_a_whole_track_fill_with_no_source_changes_nothing(tmp_path, layer):
    path = digital_guest_path(tmp_path)
    reply = LAYERS[layer](path, track_id="guest")
    assert list(reply) == WIRE_KEYS
    assert reply["pad_samples"] == []
    assert reply["clip_count"] == 2
