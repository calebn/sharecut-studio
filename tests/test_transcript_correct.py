from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_correct import (
    apply_transcript_corrections,
    correct_word,
    list_low_confidence,
    set_word_suppressed,
)
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord


def test_correct_word_and_low_confidence() -> None:
    p = EpisodeProject.create("tc", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="teh", start=0.0, end=0.5, confidence=0.4),
                TranscriptWord(text="end", start=1.0, end=1.5, confidence=0.95),
            ],
        )
    ]
    low = list_low_confidence(p, threshold=0.7)
    assert len(low) == 1
    assert low[0]["text"] == "teh"
    correct_word(p, "host", 0, "the")
    assert p.transcripts[0].words[0].text == "the"
    assert p.transcripts[0].words[0].confidence == 1.0


def test_set_word_suppressed_toggles_and_rebuilds() -> None:
    p = EpisodeProject.create("tc-sup", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
                TranscriptWord(text="world", start=0.6, end=1.0, confidence=0.9),
            ],
        )
    ]
    out = set_word_suppressed(p, "host", 1, True)
    assert out["suppressed"] is True
    assert p.transcripts[0].words[1].suppressed is True
    assert p.combined_transcript is not None
    combined_text = " ".join(u.text for u in p.combined_transcript.utterances)
    assert "world" not in combined_text

    out2 = set_word_suppressed(p, "host", 1, False)
    assert out2["suppressed"] is False
    assert p.transcripts[0].words[1].suppressed is False
    combined_text2 = " ".join(u.text for u in p.combined_transcript.utterances)
    assert "world" in combined_text2


def test_apply_transcript_corrections_word_and_phrase() -> None:
    p = EpisodeProject.create("tc", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="Shotterfield", start=1.0, end=2.0, confidence=0.3),
                TranscriptWord(text="end", start=2.0, end=3.0, confidence=0.95),
            ],
        )
    ]
    n = apply_transcript_corrections(
        p,
        "host",
        words=[{"word_index": 1, "text": "done."}],
        phrases=[{"start_word_index": 0, "end_word_index": 0, "text": "Shot of Truth"}],
    )
    assert n == 2
    words = p.transcripts[0].words
    assert [w.text for w in words] == ["Shot", "of", "Truth", "done."]
    assert words[0].start == 1.0
    assert words[-1].end == 3.0


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "\u200b",  # zero-width space
        "\ufeff",  # byte-order mark
        "\u2060",  # word joiner
        "\u200e",  # left-to-right mark
        "\x00",  # NUL
        " \u200b\ufeff\u2060\u200e\x00\t ",
    ],
)
def test_correct_word_rejects_empty_or_invisible_text(text: str) -> None:
    p = EpisodeProject.create("tc-empty", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9),
            ],
        )
    ]
    with pytest.raises(ValueError, match="must not be empty"):
        correct_word(p, "host", 0, text)
    # word left untouched
    assert p.transcripts[0].words[0].text == "hello"


def test_correct_word_allows_visible_text_with_format_characters() -> None:
    p = EpisodeProject.create("tc-visible", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="hello", start=0.0, end=0.5, confidence=0.9)],
        )
    ]

    correct_word(p, "host", 0, "\u200bhello\ufeff")

    assert p.transcripts[0].words[0].text == "\u200bhello\ufeff"
