"""Typed word-timing results keep their wire shape (#1811)."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from podcast_mcp.edits.transcript_timing import (
    WordTimingChange,
    WordTimingContext,
    WordTimingNeighbor,
    WordTimingTarget,
)
from podcast_mcp.services.document import TranscriptService
from test_transcript_timing import workspace

pytestmark = pytest.mark.unscoped_ok

EXTRA = WordTimingTarget("host", "extra", 0)
CONTEXT_KEYS = [
    "target",
    "expected_token",
    "word",
    "neighbors",
    "media",
    "window",
    "warnings",
    "transcript_gate",
]
NEIGHBOR_KEYS = ["word_index", "text", "start", "end"]


def build(**over):
    fields = {
        "target": EXTRA,
        "expected_token": "t",
        "word": {"text": "same", "trimmed_from": [1.0, 2.0]},
        "neighbors": [WordTimingNeighbor(word_index=0, text="same", start=1.5, end=2.5)],
        "media": {"duration_sec": 30},
        "window": {"start": 0.0, "end": 30},
        "warnings": [],
        "transcript_gate": False,
    }
    return WordTimingContext(**{**fields, **over})


def test_models_are_frozen_and_forbid_extra():
    ctx = build()
    with pytest.raises(ValidationError):
        ctx.expected_token = "x"
    with pytest.raises(ValidationError):
        ctx.neighbors[0].start = 0.0
    with pytest.raises(ValidationError):
        WordTimingChange(changed=True, context=ctx, extra=1)
    with pytest.raises(ValidationError):
        WordTimingContext(**ctx.model_dump(), extra=1)
    with pytest.raises(ValidationError):
        WordTimingNeighbor(word_index=0, text="a", start=1, end=2, extra=1)


def test_field_order_is_wire_order():
    assert list(WordTimingContext.model_fields) == CONTEXT_KEYS
    assert list(WordTimingChange.model_fields) == ["changed", "context"]
    assert list(WordTimingNeighbor.model_fields) == NEIGHBOR_KEYS


def test_int_neighbor_times_stay_int():
    row = WordTimingNeighbor(word_index=1, text="a", start=1, end=2.5).model_dump()
    assert type(row["start"]) is int
    assert type(row["end"]) is float
    assert json.dumps(row) == '{"word_index": 1, "text": "a", "start": 1, "end": 2.5}'


def test_int_window_and_media_stay_int():
    dump = build().model_dump()
    assert type(dump["window"]["end"]) is int
    assert type(dump["media"]["duration_sec"]) is int


def test_dump_is_plain_python_with_list_trimmed_from():
    dump = WordTimingChange(changed=True, context=build()).model_dump()
    assert type(dump) is dict
    assert type(dump["context"]) is dict
    assert type(dump["context"]["target"]) is dict
    assert list(dump["context"]["target"]) == ["track_id", "source_id", "word_index"]
    assert dump["context"]["target"] == {"track_id": "host", "source_id": "extra", "word_index": 0}
    assert dump["context"]["word"]["trimmed_from"] == [1.0, 2.0]
    assert type(dump["context"]["word"]["trimmed_from"]) is list


def test_service_returns_models(minimal_project):
    svc = TranscriptService(workspace(minimal_project))
    ctx = svc.word_timing_context(EXTRA)
    assert type(ctx) is WordTimingContext
    change = svc.set_word_timing(EXTRA, ctx.expected_token, 1.25, 2.25)
    assert type(change) is WordTimingChange
    assert list(change.model_dump()) == ["changed", "context"]
