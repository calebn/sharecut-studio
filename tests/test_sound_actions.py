"""One table pins every sound kind's label and default suggested action (#1434)."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.sound_actions import SOUND_ACTIONS, sound_kind, sound_label_and_action

# reason -> (kind, label, default action).  A new row in SOUND_ACTIONS needs a line here
# only when a detector emits its kind.
CASES = [
    ("filler:um", "filler", "Filler word", "cut"),
    ("filler:uh:risky", "filler", "Filler word", "cut"),
    ("pause:2.1s", "pause", "Long pause", "shorten"),
    ("repetition:the", "repetition", "Repeated words", "cut"),
    ("restart:we", "restart", "False start", "cut"),
    ("filler:acoustic", "acoustic", "Unclear sound", "leave"),
    ("filler:acoustic:likely_laugh", "laugh", "Laugh", "lower"),
    ("filler:acoustic:other_speaking:likely_laugh", "laugh", "Laugh", "lower"),
    ("filler:acoustic:possible_word", "possible_word", "Possible missed word", "leave"),
]


@pytest.mark.parametrize(("reason", "kind", "label", "action"), CASES)
def test_default_label_and_action(reason: str, kind: str, label: str, action: str) -> None:
    assert sound_kind(reason) == kind
    assert sound_label_and_action(reason) == (label, action)
    assert SOUND_ACTIONS[kind].action == action


def test_non_tighten_reason_has_no_suggestion() -> None:
    assert sound_label_and_action("manual cut") is None
    assert sound_label_and_action(None) is None
