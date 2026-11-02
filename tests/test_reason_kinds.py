from __future__ import annotations

import pytest

from podcast_mcp.edits.cut_policy import review_kind, sound_kind
from podcast_mcp.edits.tighten_reasons import is_filler_reason, is_pause_reason

_FILLER_REASONS = (
    "filler:um",
    "filler:acoustic",
    "filler:acoustic:possible_word",
    "filler:acoustic:likely_laugh",
)
_NON_FILLER_REASONS = (
    None,
    "",
    "pause:0.80s",
    "repetition:word:the",
    "restart:partial:so",
    "manual",
    "filler",
    "fillers",
)


@pytest.mark.parametrize("reason", _FILLER_REASONS)
def test_every_filler_reason_is_a_filler_and_a_reviewed_kind(reason: str) -> None:
    assert is_filler_reason(reason)
    assert not is_pause_reason(reason)
    assert sound_kind(reason) in {"filler", "acoustic", "possible_word", "laugh"}
    assert review_kind(reason) != "other"


@pytest.mark.parametrize("reason", _NON_FILLER_REASONS)
def test_other_reasons_are_not_fillers(reason: str | None) -> None:
    assert not is_filler_reason(reason)


@pytest.mark.parametrize("reason", ["pause:0.80s", "pause:2.00s:risky", "pause:"])
def test_pause_reasons_are_pauses(reason: str) -> None:
    assert is_pause_reason(reason)
    assert sound_kind(reason) == "pause"


@pytest.mark.parametrize(
    "reason", [None, "", "filler:um", "repetition:word:the", "unpause:1s", "pausing", "pause"]
)
def test_other_reasons_are_not_pauses(reason: str | None) -> None:
    assert not is_pause_reason(reason)


@pytest.mark.parametrize("reason", [*_FILLER_REASONS, *_NON_FILLER_REASONS, "pause:1.00s"])
def test_helpers_agree_with_the_sound_kind_table(reason: str | None) -> None:
    kind = sound_kind(reason)
    assert is_pause_reason(reason) == (kind == "pause")
    assert is_filler_reason(reason) == (kind in {"filler", "acoustic", "possible_word", "laugh"})
