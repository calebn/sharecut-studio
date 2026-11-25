from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import SessionHearResult
from podcast_mcp.services.document.session_hear_results import (
    SESSION_HEAR_PUBLIC_EXCLUDE,
    SessionHearCurrentSide,
    SessionHearSuggestedSide,
)


def _result() -> SessionHearResult:
    return SessionHearResult(
        suggestion_id="ss-1",
        kind="replace",
        mode="ab",
        take_index=0,
        pad_sec=1.5,
        wav="/x/a.wav",
        player=None,
        current=SessionHearCurrentSide(wav="/x/c.wav", start_s=1.0, end_s=2.0),
        suggested=SessionHearSuggestedSide(wav="/x/s.wav", start_s=1.0, end_s=3.0, delta_s=1.0),
        delta_s=1.0,
        removed_s=None,
        span_s=None,
        speech=None,
        speech_message=None,
    )


def test_models_are_frozen() -> None:
    result = _result()
    with pytest.raises(ValidationError):
        result.wav = "other"  # type: ignore[misc]
    with pytest.raises(ValidationError):
        result.current.start_s = 0.0  # type: ignore[union-attr,misc]


def test_models_forbid_extra_keys() -> None:
    with pytest.raises(ValidationError):
        SessionHearCurrentSide(wav="a", start_s=0.0, end_s=1.0, delta_s=1.0)  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        SessionHearResult.model_validate({**_result().model_dump(), "extra": 1})


def test_mode_is_one_of_the_three_sides() -> None:
    with pytest.raises(ValidationError):
        SessionHearResult.model_validate({**_result().model_dump(), "mode": "both"})


def test_dump_keeps_the_wire_key_order_and_nulls() -> None:
    dumped = _result().model_dump()
    assert list(dumped) == [
        "suggestion_id",
        "kind",
        "mode",
        "take_index",
        "pad_sec",
        "wav",
        "player",
        "current",
        "suggested",
        "delta_s",
        "removed_s",
        "span_s",
        "speech",
        "speech_message",
    ]
    assert list(dumped["current"]) == ["wav", "start_s", "end_s"]
    assert list(dumped["suggested"]) == ["wav", "start_s", "end_s", "delta_s"]
    assert dumped["removed_s"] is None


def test_public_exclude_drops_every_host_path() -> None:
    public = _result().model_dump(exclude=SESSION_HEAR_PUBLIC_EXCLUDE)
    assert "wav" not in public and "player" not in public
    assert list(public["current"]) == ["start_s", "end_s"]
    assert list(public["suggested"]) == ["start_s", "end_s", "delta_s"]
