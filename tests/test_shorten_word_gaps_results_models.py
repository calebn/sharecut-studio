from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from pause_policy_public_helpers import configure, defaults
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    ShortenWordGapsApplied,
    ShortenWordGapsHeld,
    ShortenWordGapsUnchanged,
    TimelineService,
)
from test_shorten_gaps_tool_pin import _HELD_WORDS, _HOST_GAP, _path

pytestmark = pytest.mark.unscoped_ok

APPLIED_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "max_gap_sec",
    "use_inaudible_opt",
    "timeline_start",
    "timeline_end",
    "span_count",
    "per_track_source",
]


def _applied(**over):
    data = {
        "operation": "shorten_word_gaps",
        "affected_tracks": ["host"],
        "clip_count": 2,
        "timeline_duration_sec": 5.5,
        "max_gap_sec": 1,
        "use_inaudible_opt": None,
        "timeline_start": 0,
        "timeline_end": 0.65,
        "span_count": 1,
        "per_track_source": {"host": [0.2, 0.65]},
    }
    return {**data, **over}


def test_applied_dump_key_order_and_omits_unset_cut_speech():
    dumped = ShortenWordGapsApplied(**_applied()).model_dump(mode="json")
    assert list(dumped) == APPLIED_KEYS


def test_applied_dump_keeps_present_cut_speech_last():
    dumped = ShortenWordGapsApplied(**_applied(cut_speech={"a": 1})).model_dump(mode="json")
    assert list(dumped) == [*APPLIED_KEYS, "cut_speech"]
    assert dumped["cut_speech"] == {"a": 1}


def test_applied_dump_keeps_none_use_inaudible_opt():
    dumped = ShortenWordGapsApplied(**_applied()).model_dump(mode="json")
    assert dumped["use_inaudible_opt"] is None


def test_applied_dump_keeps_int_max_gap_sec_and_bounds():
    dumped = ShortenWordGapsApplied(**_applied()).model_dump(mode="json")
    assert type(dumped["max_gap_sec"]) is int
    assert type(dumped["timeline_start"]) is int
    assert type(dumped["timeline_end"]) is float


def test_extra_keys_are_rejected():
    with pytest.raises(ValidationError):
        ShortenWordGapsApplied(**_applied(extra=1))
    with pytest.raises(ValidationError):
        ShortenWordGapsUnchanged(
            operation="shorten_word_gaps",
            affected_tracks=[],
            clip_count=1,
            timeline_duration_sec=1.0,
            unchanged=True,
            extra=1,
        )
    with pytest.raises(ValidationError):
        ShortenWordGapsHeld(
            operation="shorten_word_gaps",
            unchanged=True,
            needs_confirmation={},
            apply_anyway="x",
            extra=1,
        )


def test_models_are_frozen():
    model = ShortenWordGapsApplied(**_applied())
    with pytest.raises(ValidationError):
        model.clip_count = 3


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    configure(monkeypatch, defaults())


def _shorten(path: str, max_gap: float, inaudible: bool = False):
    ws = ProjectWorkspace.open(Path(path))
    return TimelineService(ws).shorten_word_gaps(max_gap, use_inaudible_opt=inaudible)


def test_service_returns_applied_model(tmp_path):
    assert isinstance(_shorten(_path(tmp_path, _HOST_GAP, "a"), 0.35), ShortenWordGapsApplied)


def test_service_returns_unchanged_model(tmp_path):
    assert isinstance(_shorten(_path(tmp_path, _HOST_GAP, "u"), 5.0), ShortenWordGapsUnchanged)


def test_service_returns_held_model(tmp_path):
    assert isinstance(_shorten(_path(tmp_path, _HELD_WORDS, "h"), 0.35), ShortenWordGapsHeld)
