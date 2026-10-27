"""Pins what the server's reason-prefix parsing does today (#2430).

The sites pinned as divergent read a different prefix set than ``review_kind`` and keep
their own rule.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.cut_policy import decision_policy, review_kind, sound_kind
from podcast_mcp.edits.tighten.propose import (
    _edit_payload,
    _keep_on_reproposal,
    format_tighten_propose_summary,
)
from podcast_mcp.edits.tighten_hits import (
    is_harsh_tighten_hit,
    is_listen_one_by_one_hit,
    is_tighten_reason,
)
from podcast_mcp.gui.mapper import map_pending_edits_to_timeline
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


@pytest.mark.parametrize("reason", TIGHTEN_REASONS)
def test_generated_reasons_are_tighten(reason: str) -> None:
    assert is_tighten_reason(reason) is True


@pytest.mark.parametrize("reason", NON_TIGHTEN_REASONS)
def test_other_reasons_are_not_tighten(reason: str | None) -> None:
    assert is_tighten_reason(reason) is False


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


def test_acoustic_laugh_count_overlaps_the_word_count_unlike_sound_kind() -> None:
    both = _decision("filler:acoustic:likely_laugh:possible_word")
    assert sound_kind(both.reason) == "possible_word"
    assert format_tighten_propose_summary([both]) == (
        "1 proposed (0 filler, 0 pause, 1 acoustic (review, 1 likely laugh, 1 possible missed word))"
    )


def test_policy_less_reasons_have_no_label_or_action() -> None:
    for reason in NON_TIGHTEN_REASONS:
        assert decision_policy(_decision(reason)) is None
        assert review_kind(reason) == "other"
        assert sound_kind(reason) is None


EDIT_DECISION_KEYS = sorted(_decision("filler:um").model_dump())
REVIEW_FIELD_KEYS = ["kind", "label", "sound_kind", "suggested_action"]


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


def test_list_edit_decisions_tool_rows_carry_review_fields(tmp_path: Path) -> None:
    path = _seeded_project(tmp_path)
    rows = json.loads(mcp_server.list_edit_decisions_tool(path))
    assert [r["id"] for r in rows] == ["filler", "laugh", "pause", "nl", "bare"]
    for row in rows:
        assert sorted(row) == sorted([*EDIT_DECISION_KEYS, *REVIEW_FIELD_KEYS])
    assert set(REVIEW_FIELD_KEYS).isdisjoint(EDIT_DECISION_KEYS)
    assert rows[1]["reason"] == "filler:acoustic:likely_laugh"


def test_cli_edit_list_pending_rows_carry_review_fields(tmp_path: Path) -> None:
    path = _seeded_project(tmp_path)
    result = CliRunner().invoke(app, ["edit", "list", "--project", path, "--pending"])
    assert result.exit_code == 0
    rows = json.loads(result.stdout)
    assert [r["id"] for r in rows] == ["laugh", "nl"]
    for row in rows:
        assert sorted(row) == sorted([*EDIT_DECISION_KEYS, *REVIEW_FIELD_KEYS])
    assert rows[0]["kind"] == "sound"
    assert rows[0]["sound_kind"] == "laugh"


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


def test_list_edit_decisions_tool_review_fields_match_the_other_surfaces(tmp_path: Path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    project = load_project(Path(path))
    muted = _decision("pause:0.8s", did="muted")
    muted.type = EditDecisionType.MUTE
    project.edit_decisions = [
        muted,
        _decision("filler:um", did="filler"),
        _decision("nl:x", did="nl"),
    ]
    save_project(project, Path(path))

    rows = {r["id"]: r for r in json.loads(mcp_server.list_edit_decisions_tool(path))}
    assert {k: rows["muted"][k] for k in REVIEW_FIELD_KEYS} == {
        "kind": "pause",
        "sound_kind": "pause",
        "label": "Long pause",
        "suggested_action": "shorten",
    }
    assert {k: rows["nl"][k] for k in REVIEW_FIELD_KEYS} == {
        "kind": "other",
        "sound_kind": None,
        "label": None,
        "suggested_action": None,
    }
    for decision in load_project(Path(path)).edit_decisions:
        fields = {k: rows[decision.id][k] for k in REVIEW_FIELD_KEYS}
        assert rows[decision.id] == decision.model_dump() | fields
        payload = _edit_payload(decision)
        assert {k: payload[k] for k in REVIEW_FIELD_KEYS} == fields
        mapped = map_pending_edits_to_timeline(project, [decision])[0]
        assert {k: mapped[k] for k in REVIEW_FIELD_KEYS} == fields
