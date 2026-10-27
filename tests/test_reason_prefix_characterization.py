"""Pins what the server's reason-prefix parsing does today (#2430).

The sites pinned as equivalent to ``review_kind`` may move onto it. The ones pinned as
divergent read a different prefix set than ``review_kind`` and must keep their own rule.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.edits.cut_policy import decision_policy, review_kind, sound_kind
from podcast_mcp.edits.tighten.propose import _keep_on_reproposal, format_tighten_propose_summary
from podcast_mcp.edits.tighten_hits import (
    TIGHTEN_REASON_PREFIXES,
    is_harsh_tighten_hit,
    is_listen_one_by_one_hit,
    is_tighten_reason,
)
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import EditDecision, EditDecisionType, load_project, save_project

TIGHTEN_REASONS = [
    "filler:um",
    "filler:uh:risky",
    "filler:",
    "filler:acoustic",
    "filler:acoustic:likely_laugh",
    "filler:acoustic:possible_word",
    "filler:acoustic:likely_laugh:possible_word:risky",
    "pause:",
    "pause:0.80s",
    "pause:0.80s:join_review",
    "repetition:",
    "repetition:word:the",
    "restart:",
    "restart:partial:we",
    "restart:phrase:we went",
]

NON_TIGHTEN_REASONS = [
    None,
    "",
    "nl:range",
    "nl:manual",
    "nl:words",
    "nl:match:topic",
    "nl:utterance:hello",
    "guest:suggest",
    "guest:suggest_split",
    "guest:range",
    "focus:macro",
    "bleed_mute:off_speaker",
    "filler",
    "pause",
    "Filler:um",
    " filler:um",
    "unfiller:um",
    "repeat:the",
    "restarts:we",
    "acoustic",
]

ALL_REASONS = TIGHTEN_REASONS + NON_TIGHTEN_REASONS


def _decision(
    reason: str | None,
    *,
    applied: bool = False,
    review: bool = False,
    did: str = "e1",
) -> EditDecision:
    return EditDecision(
        id=did,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=1.3,
        reason=reason,
        review_required=review,
        applied=applied,
    )


def test_tighten_prefixes_are_the_four_generated_reason_codes() -> None:
    assert TIGHTEN_REASON_PREFIXES == ("filler:", "pause:", "repetition:", "restart:")


@pytest.mark.parametrize("prefix", TIGHTEN_REASON_PREFIXES)
def test_every_tighten_prefix_is_a_tighten_reason(prefix: str) -> None:
    assert is_tighten_reason(prefix) is True
    assert is_tighten_reason(f"{prefix}anything:else") is True


@pytest.mark.parametrize("reason", TIGHTEN_REASONS)
def test_generated_reasons_are_tighten(reason: str) -> None:
    assert is_tighten_reason(reason) is True


@pytest.mark.parametrize("reason", NON_TIGHTEN_REASONS)
def test_other_reasons_are_not_tighten(reason: str | None) -> None:
    assert is_tighten_reason(reason) is False


def test_is_tighten_reason_is_review_kind_not_other() -> None:
    assert [(r, is_tighten_reason(r)) for r in ALL_REASONS] == [
        (r, review_kind(r) != "other") for r in ALL_REASONS
    ]


def test_startswith_pause_is_sound_kind_pause() -> None:
    assert [(r, (r or "").startswith("pause:")) for r in ALL_REASONS] == [
        (r, sound_kind(r) == "pause") for r in ALL_REASONS
    ]


def test_harsh_and_listen_one_by_one_follow_the_tighten_prefix_set() -> None:
    rows = {
        reason: (
            is_harsh_tighten_hit(_decision(reason, review=True)),
            is_listen_one_by_one_hit(_decision(reason, review=True)),
        )
        for reason in ("filler:um", "pause:0.5s", "repetition:word:a", "restart:we", "nl:range")
    }
    assert rows == {
        "filler:um": (True, False),
        "pause:0.5s": (True, True),
        "repetition:word:a": (True, False),
        "restart:we": (True, False),
        "nl:range": (False, False),
    }


KEEP_CASES = [
    ("filler:um", False, False, False),
    ("filler:um", False, True, False),
    ("filler:um", True, False, False),
    ("filler:um", True, True, True),
    ("pause:0.5s", False, True, False),
    ("pause:0.5s", True, False, False),
    ("pause:0.5s", True, True, True),
    ("repetition:word:a", False, False, False),
    ("repetition:word:a", True, False, True),
    ("restart:we", False, True, False),
    ("restart:we", True, True, True),
    ("filler:acoustic", False, True, False),
    ("filler:acoustic", True, True, True),
    ("filler:acoustic:likely_laugh", True, False, True),
    ("filler:acoustic:possible_word", False, False, False),
    ("nl:range", False, False, True),
    ("guest:suggest", False, True, True),
    ("focus:macro", False, False, True),
    (None, False, False, True),
]


@pytest.mark.parametrize(("reason", "applied", "review", "kept"), KEEP_CASES)
def test_keep_on_reproposal(reason: str | None, applied: bool, review: bool, kept: bool) -> None:
    assert _keep_on_reproposal(_decision(reason, applied=applied, review=review)) is kept


def test_summary_counts_match_sound_kind_buckets() -> None:
    reasons = [
        "filler:um",
        "filler:uh:risky",
        "pause:0.5s",
        "repetition:word:a",
        "restart:we",
        "filler:acoustic",
        "filler:acoustic:likely_laugh",
        "filler:acoustic:possible_word",
        "filler:acoustic:likely_laugh:possible_word",
    ]
    decisions = [_decision(r, did=f"e{i}") for i, r in enumerate(reasons)]
    assert format_tighten_propose_summary(decisions) == (
        "9 proposed (2 filler, 1 pause, 2 repetition/restart,"
        " 4 acoustic (review, 2 likely laugh, 2 possible missed word))"
    )
    kinds = [sound_kind(d.reason) for d in decisions]
    assert kinds.count("filler") == 2
    assert kinds.count("pause") == 1
    assert kinds.count("repetition") + kinds.count("restart") == 2


def test_acoustic_laugh_count_overlaps_the_word_count_unlike_sound_kind() -> None:
    both = _decision("filler:acoustic:likely_laugh:possible_word")
    assert sound_kind(both.reason) == "possible_word"
    assert format_tighten_propose_summary([both]) == (
        "1 proposed (0 filler, 0 pause, 1 acoustic (review, 1 likely laugh, 1 possible missed word))"
    )


def test_social_filler_density_prefix_counts_acoustic_hits_review_kind_does_not() -> None:
    reasons = ["filler:um", "filler:acoustic", "filler:acoustic:likely_laugh"]
    assert [r.startswith("filler:") for r in reasons] == [True, True, True]
    assert [review_kind(r) for r in reasons] == ["filler", "sound", "sound"]


def test_auto_apply_prefix_pair_is_narrower_than_the_tighten_set() -> None:
    auto_apply = ("filler:", "pause:")
    reasons = ["filler:um", "pause:0.5s", "repetition:word:a", "restart:we", "filler:acoustic"]
    assert [r.startswith(auto_apply) for r in reasons] == [True, True, False, False, True]
    assert [is_tighten_reason(r) for r in reasons] == [True, True, True, True, True]


def test_policy_less_reasons_have_no_label_or_action() -> None:
    for reason in NON_TIGHTEN_REASONS:
        assert decision_policy(_decision(reason)) is None
        assert review_kind(reason) == "other"
        assert sound_kind(reason) is None


EDIT_DECISION_KEYS = sorted(_decision("filler:um").model_dump())


def _seeded_project(tmp_path: Path) -> str:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    proj = load_project(Path(path))
    proj.edit_decisions = [
        _decision("filler:um", did="filler"),
        _decision("filler:acoustic:likely_laugh", did="laugh", review=True),
        _decision("pause:0.8s", did="pause", applied=True),
        _decision("nl:range", did="nl", review=True),
        _decision(None, did="bare"),
    ]
    save_project(proj, Path(path))
    return path


def test_list_edit_decisions_tool_rows_are_raw_edit_decision_dumps(tmp_path: Path) -> None:
    path = _seeded_project(tmp_path)
    rows = json.loads(mcp_server.list_edit_decisions_tool(path))
    assert [r["id"] for r in rows] == ["filler", "laugh", "pause", "nl", "bare"]
    for row in rows:
        assert sorted(row) == EDIT_DECISION_KEYS
    assert {"kind", "sound_kind", "label", "suggested_action"}.isdisjoint(EDIT_DECISION_KEYS)
    assert rows[1]["reason"] == "filler:acoustic:likely_laugh"


@pytest.mark.parametrize(
    ("kwargs", "ids"),
    [
        ({}, ["filler", "laugh", "pause", "nl", "bare"]),
        ({"applied": False}, ["filler", "laugh", "nl", "bare"]),
        ({"applied": True}, ["pause"]),
        ({"review_required": True}, ["laugh", "nl"]),
        ({"review_required": False, "applied": False}, ["filler", "bare"]),
        ({"reason_prefix": "filler:"}, ["filler", "laugh"]),
        ({"reason_prefix": "filler:acoustic"}, ["laugh"]),
        ({"reason_prefix": "pause:"}, ["pause"]),
        ({"reason_prefix": "nl:"}, ["nl"]),
        ({"reason_prefix": "missing:"}, []),
        ({"reason_prefix": ""}, ["filler", "laugh", "pause", "nl", "bare"]),
    ],
)
def test_list_edit_decisions_tool_filters(
    tmp_path: Path, kwargs: dict[str, object], ids: list[str]
) -> None:
    path = _seeded_project(tmp_path)
    rows = json.loads(mcp_server.list_edit_decisions_tool(path, **kwargs))
    assert [r["id"] for r in rows] == ids
