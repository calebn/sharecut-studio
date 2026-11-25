from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from podcast_mcp.edits.timeline_ops import copy_segment
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project
from podcast_mcp.services.document import ClipboardExtract, ClipboardResult

BASE_KEYS = [
    "track_id",
    "source_start",
    "source_end",
    "relative_timeline_start",
    "source_id",
    "fade_in_ms",
    "fade_out_ms",
    "join_in_mode",
    "mute_regions",
]
OPTIONAL_KEYS = [
    "gain_db",
    "fade_in_curve",
    "fade_out_curve",
    "off_speaker_mute_regions",
    "bleed_restore",
]
FULL_KEYS = [
    "track_id",
    "source_start",
    "source_end",
    "relative_timeline_start",
    "source_id",
    "fade_in_ms",
    "fade_out_ms",
    "gain_db",
    "fade_in_curve",
    "fade_out_curve",
    "join_in_mode",
    "mute_regions",
    "off_speaker_mute_regions",
    "bleed_restore",
]


def _extract(**over):
    base = {
        "track_id": "host",
        "source_start": 1,
        "source_end": 3.5,
        "relative_timeline_start": 0,
        "source_id": None,
        "fade_in_ms": 5,
        "fade_out_ms": 7,
        "join_in_mode": "fade",
        "mute_regions": [],
    }
    return {**base, **over}


def _rich():
    return _extract(
        gain_db=-3.0,
        fade_in_curve="s",
        fade_out_curve="equal_power",
        off_speaker_mute_regions=[{"start_s": 0.1, "end_s": 0.2}],
        bleed_restore={"source_sha256": "ab", "regions": [{"start_s": 0.0, "end_s": 1.0}]},
    )


def test_plain_extract_omits_every_optional_key():
    dumped = ClipboardExtract(**_extract()).model_dump()
    assert list(dumped) == BASE_KEYS
    assert dumped == _extract()


def test_rich_extract_key_order_and_values():
    dumped = ClipboardExtract(**_rich()).model_dump(mode="json")
    assert list(dumped) == FULL_KEYS
    assert dumped == _rich()


@pytest.mark.parametrize("key", OPTIONAL_KEYS)
def test_each_optional_key_absent_not_null(key):
    dumped = ClipboardExtract(**{**_rich(), key: None}).model_dump(mode="json")
    assert key not in dumped
    assert list(dumped) == [k for k in FULL_KEYS if k != key]


def test_source_id_null_is_kept():
    dumped = ClipboardExtract(**_extract(source_id=None)).model_dump(mode="json")
    assert "source_id" in dumped
    assert dumped["source_id"] is None


def test_int_values_stay_int():
    result = ClipboardResult(duration=2, extracts=[ClipboardExtract(**_extract())])
    dumped = result.model_dump(mode="json")
    assert list(dumped) == ["duration", "extracts"]
    assert isinstance(dumped["duration"], int)
    assert isinstance(dumped["extracts"][0]["source_start"], int)
    assert isinstance(dumped["extracts"][0]["source_end"], float)


def test_empty_mute_regions_is_kept():
    assert ClipboardExtract(**_extract()).model_dump()["mute_regions"] == []


def test_extra_keys_rejected():
    with pytest.raises(ValidationError):
        ClipboardExtract(**_extract(surprise=1))
    with pytest.raises(ValidationError):
        ClipboardResult(duration=1.0, extracts=[], surprise=1)


def test_frozen():
    extract = ClipboardExtract(**_extract())
    with pytest.raises(ValidationError):
        extract.fade_in_ms = 9
    with pytest.raises(ValidationError):
        ClipboardResult(duration=1.0, extracts=[extract]).duration = 2.0


def test_non_ascii_track_id_matches_engine_dict_byte_for_byte(minimal_project):
    project = load_project(minimal_project)
    track_id = "hôte-日本"
    project.timeline.tracks = [
        Track(
            id=track_id,
            label=track_id,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/x.wav", duration_sec=80.0),
        )
    ]
    project.timeline.clips = [
        Clip(id="c1", track_id=track_id, source_start=0.0, source_end=4.0, timeline_start=0.0)
    ]
    engine = copy_segment(project, 1.0, 3.0)
    model = ClipboardResult.model_validate(engine)
    assert json.dumps(model.model_dump(mode="json"), indent=2) == json.dumps(engine, indent=2)
    assert "\\u00f4" in json.dumps(model.model_dump(mode="json"))
