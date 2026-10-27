"""The plain-language why line on a pending edit card."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.why_lines import peers_speaking, why_line
from podcast_mcp.models import CutSpeech, CutSpeechTrack, EditDecision, EditDecisionType
from podcast_mcp.models.episode import RangeInterval


def _decision(reason: str | None, *, start: float = 1.0, end: float = 1.3, **extra) -> EditDecision:
    return EditDecision(
        id="d1",
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason=reason,
        applied=False,
        **extra,
    )


def _line(reason: str | None, name: str | None = "Jon", peers: bool | None = None) -> str | None:
    return why_line(_decision(reason), speaker_name=name, peers_speaking=peers)


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        ("filler:um", "Filler word; the sentence reads the same without it"),
        ("filler:uh:risky", "Filler word; the sentence reads the same without it"),
        ("filler:acoustic:likely_laugh", "Sounds like a laugh, not a word"),
        (
            "filler:acoustic:possible_word",
            "Might be a word the transcript missed; listen before cutting",
        ),
        ("filler:acoustic", "An unclear sound; listen before deciding"),
        ("filler:acoustic:risky", "An unclear sound; listen before deciding"),
        ("repetition:word:the", "Jon says “the” twice"),
        ("repetition:word:the:risky", "Jon says “the” twice"),
        ("restart:partial:we", "Jon restarts the sentence"),
        ("restart:phrase:so the:join_review", "Jon restarts the sentence"),
    ],
)
def test_a_line_per_kind(reason: str, expected: str) -> None:
    assert _line(reason) == expected


def test_a_pause_line_names_the_gap_and_what_stays() -> None:
    decision = _decision("pause:2.90s:solo", start=10.0, end=12.5)
    assert (
        why_line(decision, speaker_name="Jon", peers_speaking=False) == "A 2.9 s gap; keeps 0.4 s"
    )


def test_a_pause_never_keeps_a_negative_length() -> None:
    decision = _decision("pause:1.00s", start=10.0, end=12.5)
    assert why_line(decision, speaker_name=None, peers_speaking=None) == "A 1.0 s gap; keeps 0.0 s"


def test_without_a_speaker_name_the_line_reads_without_one() -> None:
    assert _line("repetition:word:the", name=None) == "“the” is said twice"
    assert _line("restart:partial:we", name=None) == "The sentence restarts"


@pytest.mark.parametrize(
    ("peers", "expected"),
    [
        (False, "Jon restarts the sentence; nobody talks over it"),
        (None, "Jon restarts the sentence"),
        (True, "Jon restarts the sentence"),
    ],
)
def test_the_peer_clause_needs_peers_known_to_be_quiet(peers: bool | None, expected: str) -> None:
    assert _line("restart:partial:we", peers=peers) == expected


@pytest.mark.parametrize(
    "reason",
    [None, "", "guest:cut this", "nl:remove the intro", "manual", "filler", "playful:phrase"],
)
def test_no_line_for_guest_agent_and_manual_edits(reason: str | None) -> None:
    assert _line(reason) is None


@pytest.mark.parametrize(
    "reason",
    ["pause:", "pause:long", "pause:xs", "repetition:", "repetition:word:", "repetition:word"],
)
def test_a_reason_it_cannot_read_gives_no_line_and_never_raises(reason: str) -> None:
    assert _line(reason) is None


def test_peers_speaking_reads_the_recorded_evidence() -> None:
    cut_speech = CutSpeech(
        spans=[RangeInterval(start=1.0, end=2.0)],
        tracks=[CutSpeechTrack(track_id="guest", speaker="Mira")],
    )
    assert peers_speaking(_decision("restart:partial:we")) is False
    assert peers_speaking(_decision("restart:partial:we:other_speaking:guest")) is True
    assert peers_speaking(_decision("restart:partial:we", cut_speech=cut_speech)) is True
    assert peers_speaking(_decision("restart:partial:we", scope="track")) is True
