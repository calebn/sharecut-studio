"""One table pins every sound kind's label and default suggested action (#1434)."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.cut_policy import (
    CUT_ACTION_TABLE,
    SUGGESTED_ACTIONS,
    review_kind,
    sound_kind,
    sound_policy,
)
from podcast_mcp.edits.tighten import TightenProposal
from podcast_mcp.models.episode import EditDecision

# reason -> (kind, label, default action).  A new sound label needs a line here
# only when a detector emits its kind.
CASES = [
    ("filler:um", "filler", "Filler word", "cut"),
    ("filler:uh:risky", "filler", "Filler word", "cut"),
    ("pause:2.1s", "pause", "Long pause", "shorten"),
    ("repetition:the", "repetition", "Repeated words", "cut"),
    ("restart:we", "restart", "False start", "cut"),
    ("filler:acoustic", "acoustic", "Unclear sound", "leave"),
    ("filler:acoustic:likely_laugh", "laugh", "Laugh", "lower"),
    ("filler:acoustic:likely_laugh:other_speaking:t1,t2:risky", "laugh", "Laugh", "lower"),
    ("filler:acoustic:likely_laugh:risky", "laugh", "Laugh", "lower"),
    ("filler:acoustic:risky", "acoustic", "Unclear sound", "leave"),
    (
        "filler:acoustic:other_speaking:t1,t2:possible_word",
        "possible_word",
        "Possible missed word",
        "leave",
    ),
    # A heard word outranks a laugh flag.
    (
        "filler:acoustic:likely_laugh:possible_word",
        "possible_word",
        "Possible missed word",
        "leave",
    ),
    ("pause:", "pause", "Long pause", "shorten"),
    ("pause:0.80s:join_review", "pause", "Long pause", "shorten"),
    ("restart:phrase:we went", "restart", "False start", "cut"),
    ("repetition:word:the", "repetition", "Repeated words", "cut"),
    ("filler:acoustic:possible_word", "possible_word", "Possible missed word", "leave"),
]


@pytest.mark.parametrize(("reason", "kind", "label", "action"), CASES)
def test_default_label_and_action(reason: str, kind: str, label: str, action: str) -> None:
    assert sound_kind(reason) == kind
    for mode in ("ripple", "mute"):
        row = sound_policy(reason, mode)
        assert row is not None
        assert (row.label, row.action, row.join.value) == (
            label,
            action,
            "mute" if mode == "mute" else "splice",
        )


def test_non_tighten_reason_has_no_suggestion() -> None:
    assert sound_policy("manual cut") is None
    assert sound_policy(None) is None


def test_every_row_uses_a_known_action_and_every_case_kind_has_a_row() -> None:
    sound_kinds = {kind for _, kind, _, _ in CASES}
    assert all(
        CUT_ACTION_TABLE[(kind, mode)].action in SUGGESTED_ACTIONS
        for kind in sound_kinds
        for mode in ("ripple", "mute")
    )
    assert all(
        (kind, mode) in CUT_ACTION_TABLE for _, kind, _, _ in CASES for mode in ("ripple", "mute")
    )


def test_propose_payload_carries_label_and_action() -> None:
    laugh = EditDecision(
        id="e1", track_id="t1", start=1.0, end=2.0, reason="filler:acoustic:likely_laugh"
    )
    other = EditDecision(id="e2", track_id="t1", start=3.0, end=4.0, reason="manual")
    rows = TightenProposal([laugh, other], {}).to_payload()["edits"]
    assert (rows[0]["label"], rows[0]["suggested_action"]) == ("Laugh", "lower")
    assert (rows[1]["label"], rows[1]["suggested_action"]) == (None, None)


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        ("filler:um", "filler"),
        ("pause:2.1s:solo", "pause"),
        ("repetition:word:the", "repeat"),
        ("restart:partial:we", "false-start"),
        ("filler:acoustic", "sound"),
        ("filler:acoustic:likely_laugh", "sound"),
        ("filler:acoustic:possible_word", "sound"),
        ("guest:suggest", "other"),
        ("nl:topic", "other"),
        ("tangent", "other"),
        (None, "other"),
    ],
)
def test_review_kind_is_the_queue_group_of_a_reason(reason: str | None, expected: str) -> None:
    assert review_kind(reason) == expected


def test_every_sound_kind_maps_to_a_review_kind() -> None:
    from typing import get_args

    from podcast_mcp.edits import cut_policy

    assert {row[5] for row in cut_policy._SOUND_ACTIONS} <= set(get_args(cut_policy.ReviewKind))


def test_propose_payload_carries_kind_and_sound_kind() -> None:
    laugh = EditDecision(
        id="e1", track_id="t1", start=1.0, end=2.0, reason="filler:acoustic:likely_laugh"
    )
    other = EditDecision(id="e2", track_id="t1", start=3.0, end=4.0, reason="manual")
    rows = TightenProposal([laugh, other], {}).to_payload()["edits"]
    assert (rows[0]["kind"], rows[0]["sound_kind"]) == ("sound", "laugh")
    assert (rows[1]["kind"], rows[1]["sound_kind"]) == ("other", None)
