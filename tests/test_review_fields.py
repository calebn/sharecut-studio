"""``review_fields`` is the one place a reason becomes the four Review fields (#2430)."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.cut_policy import review_fields

FILLER = {
    "kind": "filler",
    "sound_kind": "filler",
    "label": "Filler word",
    "suggested_action": "cut",
}
PAUSE = {
    "kind": "pause",
    "sound_kind": "pause",
    "label": "Long pause",
    "suggested_action": "shorten",
}
REPEAT = {
    "kind": "repeat",
    "sound_kind": "repetition",
    "label": "Repeated words",
    "suggested_action": "cut",
}
RESTART = {
    "kind": "false-start",
    "sound_kind": "restart",
    "label": "False start",
    "suggested_action": "cut",
}
ACOUSTIC = {
    "kind": "sound",
    "sound_kind": "acoustic",
    "label": "Unclear sound",
    "suggested_action": "leave",
}
LAUGH = {
    "kind": "sound",
    "sound_kind": "laugh",
    "label": "Laugh",
    "suggested_action": "lower",
}
WORD = {
    "kind": "sound",
    "sound_kind": "possible_word",
    "label": "Possible missed word",
    "suggested_action": "leave",
}
OTHER = {"kind": "other", "sound_kind": None, "label": None, "suggested_action": None}

EXPECTED = {
    "filler:um": FILLER,
    "filler:uh:risky": FILLER,
    "pause:2.1s": PAUSE,
    "repetition:the": REPEAT,
    "restart:we": RESTART,
    "filler:acoustic": ACOUSTIC,
    "filler:acoustic:likely_laugh": LAUGH,
    "filler:acoustic:likely_laugh:other_speaking:t1,t2:risky": LAUGH,
    "filler:acoustic:likely_laugh:risky": LAUGH,
    "filler:acoustic:risky": ACOUSTIC,
    "filler:acoustic:other_speaking:t1,t2:possible_word": WORD,
    "filler:acoustic:likely_laugh:possible_word": WORD,
    "pause:": PAUSE,
    "pause:0.80s:join_review": PAUSE,
    "restart:phrase:we went": RESTART,
    "repetition:word:the": REPEAT,
    "filler:acoustic:possible_word": WORD,
    None: OTHER,
    "": OTHER,
    "nl:x": OTHER,
    "guest:x": OTHER,
    "focus:x": OTHER,
    "bleed_mute": OTHER,
}


@pytest.mark.parametrize(("reason", "fields"), list(EXPECTED.items()))
def test_review_fields(reason: str | None, fields: dict[str, str | None]) -> None:
    assert dict(review_fields(reason)) == fields
