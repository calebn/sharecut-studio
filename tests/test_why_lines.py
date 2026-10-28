"""The plain-language why line on a pending edit card."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from podcast_mcp.edits.tighten_hits import MAX_QUOTED_CHARS, why_line
from podcast_mcp.models import EditDecision, EditDecisionType

_DOCS = Path(__file__).resolve().parents[1] / "docs" / "communication-philosophy.md"


def _decision(reason: str | None, *, start: float = 1.0, end: float = 1.3) -> EditDecision:
    return EditDecision(
        id="d1",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason=reason,
        applied=False,
    )


def _line(reason: str | None, name: str | None = "Jon") -> str | None:
    return why_line(_decision(reason), speaker_name=name)


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        ("filler:um", "Filler word"),
        ("filler:uh:risky", "Filler word"),
        ("filler:acoustic:likely_laugh", "Might be a laugh; listen before cutting"),
        (
            "filler:acoustic:possible_word",
            "Might be a word the transcript missed; listen before cutting",
        ),
        ("filler:acoustic", "An unclear sound; listen before deciding"),
        ("filler:acoustic:risky", "An unclear sound; listen before deciding"),
        ("pause:2.90s", "A 2.9 s gap"),
        ("pause:2.90s:solo:voiced_edge", "A 2.9 s gap"),
        ("repetition:word:the", "Jon says “the” twice"),
        ("repetition:word:the:risky", "Jon says “the” twice"),
        ("repetition:word:10:30", "Jon says “10:30” twice"),
        ("repetition:word:10:30:join_review:risky", "Jon says “10:30” twice"),
        ("repetition:word:risky", "Jon says “risky” twice"),
        ("repetition:word:risky:risky", "Jon says “risky” twice"),
        ("restart:partial:we", "Jon cuts off a word and says it again"),
        ("restart:phrase:so the:join_review", "Jon repeats a phrase"),
    ],
)
def test_a_line_per_kind(reason: str, expected: str) -> None:
    assert _line(reason) == expected


def test_a_pause_line_states_only_the_gap_the_reason_records() -> None:
    decision = _decision("pause:3.00s", start=10.0, end=15.45)
    assert why_line(decision, speaker_name="Jon") == "A 3.0 s gap"


def test_without_a_speaker_name_the_line_reads_without_one() -> None:
    assert _line("repetition:word:the", name=None) == "“the” is said twice"
    assert _line("restart:partial:we", name=None) == "A word is cut off and said again"
    assert _line("restart:phrase:so the", name=None) == "A phrase is repeated"


@pytest.mark.parametrize("name", ["", "   ", "\x00\n", None])
def test_a_blank_speaker_name_counts_as_no_name(name: str | None) -> None:
    assert _line("repetition:word:the", name=name) == "“the” is said twice"


def test_a_speaker_name_is_trimmed_cleaned_and_capped() -> None:
    assert _line("repetition:word:the", name="  Jo\x00n \n") == "Jon says “the” twice"
    long = _line("repetition:word:the", name="N" * 40)
    assert long == f"{'N' * MAX_QUOTED_CHARS}… says “the” twice"


@pytest.mark.parametrize("gap", ["9" * 400, "3600.00", "99999.0"])
def test_an_absurd_pause_gap_gives_no_line(gap: str) -> None:
    assert _line(f"pause:{gap}s") is None


def test_a_long_repeated_word_is_capped_and_control_characters_are_dropped() -> None:
    long = "a" * 40
    assert _line(f"repetition:word:{long}") == f"Jon says “{'a' * MAX_QUOTED_CHARS}…” twice"
    assert _line("repetition:word:ab\x00c\n") == "Jon says “abc” twice"


@pytest.mark.parametrize(
    "reason",
    [None, "", "guest:cut this", "nl:remove the intro", "manual", "filler", "playful:phrase"],
)
def test_no_line_for_unreadable_reasons(reason: str | None) -> None:
    assert _line(reason) is None


@pytest.mark.parametrize("reason", ["repetition:word:the", "filler:um", "pause:3.8"])
def test_no_line_on_a_share_guests_suggestion(reason: str) -> None:
    decision = _decision(reason).model_copy(update={"author": "share:abc"})
    assert why_line(decision, speaker_name="Jon") is None


@pytest.mark.parametrize(
    "reason",
    [
        "pause:",
        "pause:long",
        "pause:xs",
        "repetition:",
        "repetition:word:",
        "repetition:word:\x00",
        "repetition:the",
    ],
)
def test_a_reason_it_cannot_read_gives_no_line_and_never_raises(reason: str) -> None:
    assert _line(reason) is None


def test_the_copy_table_in_the_docs_matches_the_code() -> None:
    section = _DOCS.read_text().split("## Why lines on suggestions", 1)[1].split("\n## ", 1)[0]
    table = [
        [cell.strip() for cell in row.strip("|").split("|")]
        for row in section.splitlines()
        if row.startswith("|") and not row.startswith("|--")
    ][1:]
    docs = {kind: re.sub(r"\{(\w+)\}", r"<\1>", line) for kind, line in table}
    samples = {
        "Filler word": "filler:um",
        "Pause": "pause:2.90s",
        "Repeated word": "repetition:word:the",
        "False start, cut-off word": "restart:partial:we",
        "False start, repeated phrase": "restart:phrase:so the",
        "Laugh": "filler:acoustic:likely_laugh",
        "Possible missed word": "filler:acoustic:possible_word",
        "Unclear sound": "filler:acoustic",
    }
    assert set(docs) == set(samples)
    for kind, reason in samples.items():
        produced = _line(reason, name="Jon")
        assert produced is not None
        produced = produced.replace("Jon", "<Name>").replace("“the”", "“<word>”")
        produced = produced.replace("2.9", "<gap>")
        assert produced == docs[kind], kind


def test_a_guest_view_keeps_the_why_line_on_pending_edits() -> None:
    from podcast_mcp.services.collaboration.share import sanitize_guest_project_view

    row = {"id": "d1", "reason": "filler:um", "why": "Filler word"}
    view = sanitize_guest_project_view({"pending_edits": [row]})
    assert view["pending_edits"] == [row]
