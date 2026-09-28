from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_correct import (
    apply_transcript_corrections,
    correct_word,
    list_low_confidence,
    run_user_transcript_edit,
    set_word_suppressed,
    set_words_ignored,
    transcript_word_record,
    verify_words,
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
    assert low[0]["source_id"] is None
    assert low[0]["word_index"] == 0
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


def _ignore_project() -> EpisodeProject:
    p = EpisodeProject.create("tc-ignore", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="so", start=0.0, end=0.3, confidence=0.9),
                TranscriptWord(text="um", start=0.3, end=0.5, confidence=0.9),
                TranscriptWord(text="like", start=0.5, end=0.8, confidence=0.9),
                TranscriptWord(text="hi", start=0.8, end=1.0, confidence=0.9),
            ],
        )
    ]
    return p


def test_set_words_ignored_range() -> None:
    p = _ignore_project()
    out = set_words_ignored(p, "host", 1, 2, True)
    assert out == {
        "track_id": "host",
        "start_word_index": 1,
        "end_word_index": 2,
        "ignored": True,
        "changed": 2,
    }
    words = p.transcripts[0].words
    assert [w.ignored for w in words] == [False, True, True, False]


def test_set_words_ignored_restore() -> None:
    p = _ignore_project()
    set_words_ignored(p, "host", 1, 2, True)
    out = set_words_ignored(p, "host", 1, 2, False)
    assert out["changed"] == 2
    assert all(not w.ignored for w in p.transcripts[0].words)


def test_set_words_ignored_noop_reports_zero_changed() -> None:
    p = _ignore_project()
    set_words_ignored(p, "host", 1, 2, True)
    out = set_words_ignored(p, "host", 1, 2, True)
    assert out["changed"] == 0


def test_set_words_ignored_bad_range_raises() -> None:
    p = _ignore_project()
    with pytest.raises(ValueError):
        set_words_ignored(p, "host", -1, 1, True)
    with pytest.raises(ValueError):
        set_words_ignored(p, "host", 0, 99, True)
    with pytest.raises(ValueError):
        set_words_ignored(p, "host", 2, 1, True)
    with pytest.raises(ValueError):
        set_words_ignored(p, "missing-track", 0, 1, True)


def test_set_words_ignored_does_not_touch_text_or_combined() -> None:
    p = _ignore_project()
    from podcast_mcp.edits.transcript_sync import rebuild_combined

    rebuild_combined(p)
    before_text = " ".join(
        u.text for u in (p.combined_transcript.utterances if p.combined_transcript else [])
    )
    set_words_ignored(p, "host", 1, 2, True)
    assert [w.text for w in p.transcripts[0].words] == ["so", "um", "like", "hi"]
    after_text = " ".join(
        u.text for u in (p.combined_transcript.utterances if p.combined_transcript else [])
    )
    assert after_text == before_text


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


def test_apply_transcript_corrections_rebuilds_combined_once(monkeypatch) -> None:
    from podcast_mcp.edits import transcript_correct

    p = EpisodeProject.create("bulk", "/tmp")
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="one", start=0, end=1),
                TranscriptWord(text="two", start=1, end=2),
            ],
        )
    ]
    original = transcript_correct.rebuild_combined
    calls = []

    def rebuild(project):
        calls.append(project)
        original(project)

    monkeypatch.setattr(transcript_correct, "rebuild_combined", rebuild)
    assert (
        apply_transcript_corrections(
            p,
            "host",
            words=[{"word_index": 0, "text": "first"}, {"word_index": 1, "text": "second"}],
        )
        == 2
    )
    assert calls == [p]
    assert [word.text for word in p.transcripts[0].words] == ["first", "second"]


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


def test_edits_layer_corrections_do_not_flag_user_edited() -> None:
    p = EpisodeProject.create("tc", "/tmp")
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="teh", start=0.0, end=0.5)])
    ]
    apply_transcript_corrections(p, "host", words=[{"word_index": 0, "text": "the"}])
    assert p.transcripts[0].words[0].text == "the"
    assert p.transcripts[0].user_edited is False


def test_user_edit_flags_only_the_resolved_transcript() -> None:
    p = EpisodeProject.create("tc", "/tmp")
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="teh", start=0.0, end=0.5)]),
        Transcript(
            track_id="host",
            source_id="b",
            words=[TranscriptWord(text="x", start=0.0, end=0.5)],
        ),
    ]
    run_user_transcript_edit(p, "host", lambda q: correct_word(q, "host", 0, "the"))
    assert p.transcripts[0].user_edited is True
    assert p.transcripts[1].user_edited is False


def test_user_edit_noop_does_not_flag() -> None:
    p = EpisodeProject.create("tc", "/tmp")
    p.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hi", start=0.0, end=0.5)])
    ]
    assert run_user_transcript_edit(p, "host", lambda q: verify_words(q, "host", [])) == 0
    assert p.transcripts[0].user_edited is False


def test_transcript_word_record_includes_source_id() -> None:
    tr = Transcript(
        track_id="host", source_id="s1", words=[TranscriptWord(text="a", start=1.0, end=1.2)]
    )
    assert transcript_word_record(tr, 0) == {
        "track_id": "host",
        "source_id": "s1",
        "word_index": 0,
        "text": "a",
        "start": 1.0,
        "end": 1.2,
    }
