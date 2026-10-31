"""The segment file format."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from podcast_mcp.segments.model import (
    SegmentFile,
    parse_segment,
    segment_id_for,
    segment_json,
    segment_kind,
)
from podcast_mcp.util.coded_error import CodedValueError

SHA = "a" * 64


def _data(**changes: object) -> dict:
    data: dict = {
        "schema_version": 1,
        "id": segment_id_for("Warm Intro"),
        "name": "Warm Intro",
        "kind": "intro",
        "role": "intro",
        "clips": [{"audio": "a.flac", "offset_sec": 0, "duration_sec": 2.5}],
        "media": {"a.flac": {"sha256": SHA, "bytes": 10}},
    }
    data.update(changes)
    return data


def test_id_is_a_slug_plus_a_short_hash_of_the_exact_name() -> None:
    first = segment_id_for("Warm Intro")
    assert first.startswith("warm-intro-")
    assert len(first.rsplit("-", 1)[1]) == 8
    assert segment_id_for("Warm  Intro") != first
    assert segment_id_for("  Warm Intro ") == first


def test_a_name_without_letters_or_digits_is_refused() -> None:
    with pytest.raises(CodedValueError) as raised:
        segment_id_for("!!!")
    assert raised.value.code == "segment_name_invalid"


def test_a_valid_segment_round_trips_through_json() -> None:
    segment = parse_segment(json.dumps(_data()))
    assert parse_segment(segment_json(segment)) == segment
    assert segment.duration_sec == 2.5
    assert segment.transcript_words is None


def test_unknown_fields_are_refused() -> None:
    with pytest.raises(CodedValueError) as raised:
        parse_segment(json.dumps(_data(extra=1)))
    assert raised.value.code == "segment_invalid"


def test_another_schema_version_is_unsupported() -> None:
    with pytest.raises(CodedValueError) as raised:
        parse_segment(json.dumps(_data(schema_version=2)))
    assert raised.value.code == "segment_schema_unsupported"


@pytest.mark.parametrize("raw", ["not json", "[1]"])
def test_unreadable_json_is_invalid(raw: str) -> None:
    with pytest.raises(CodedValueError) as raised:
        parse_segment(raw)
    assert raised.value.code == "segment_invalid"


@pytest.mark.parametrize(
    "changes",
    [
        {"kind": "jingle"},
        {"version": 0},
        {"clips": []},
        {"id": "Bad Id"},
        {"clips": [{"audio": "missing.flac", "offset_sec": 0, "duration_sec": 1}]},
        {"clips": [{"audio": "a.flac", "offset_sec": -1, "duration_sec": 1}]},
        {"clips": [{"audio": "a.flac", "offset_sec": 0, "duration_sec": 0}]},
        {"media": {"../a.flac": {"sha256": SHA, "bytes": 1}}},
        {"media": {"a.flac": {"sha256": "xyz", "bytes": 1}}},
        {"media": {"segment.json": {"sha256": SHA, "bytes": 1}}},
    ],
)
def test_invalid_segments_are_refused(changes: dict) -> None:
    with pytest.raises((CodedValueError, ValidationError)):
        parse_segment(json.dumps(_data(**changes)))


def test_transcript_words_are_validated() -> None:
    words = [{"text": "hello", "start": 0.1, "end": 0.4}]
    assert parse_segment(json.dumps(_data(transcript_words=words))).transcript_words
    backwards = [{"text": "hello", "start": 0.5, "end": 0.4}]
    with pytest.raises(CodedValueError):
        parse_segment(json.dumps(_data(transcript_words=backwards)))


def test_content_hash_ignores_name_and_version_but_not_audio_or_layout() -> None:
    base = SegmentFile.model_validate(_data())
    renamed = SegmentFile.model_validate(_data(name="Other", id=segment_id_for("Other"), version=3))
    other_audio = SegmentFile.model_validate(
        _data(media={"a.flac": {"sha256": "b" * 64, "bytes": 10}})
    )
    other_layout = SegmentFile.model_validate(_data(fader_db=-3.0))
    assert renamed.content_sha256 == base.content_sha256
    assert other_audio.content_sha256 != base.content_sha256
    assert other_layout.content_sha256 != base.content_sha256


def test_segment_kind_names_the_five_kinds() -> None:
    assert segment_kind("sting") == "sting"
    with pytest.raises(CodedValueError) as raised:
        segment_kind("jingle")
    assert raised.value.code == "segment_kind_invalid"
