from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.models.episode import Transcript, TranscriptWord
from podcast_mcp.util.wer import (
    WerResult,
    accuracy_for_track,
    clip_words_to_duration,
    load_fixture_transcripts,
    load_ground_truth_words,
    speech_windows,
    tokens_from_text,
    tokens_from_words,
    word_error_rate,
    words_in_windows,
)


def test_transcript_workflows_share_canonical_token_normalizer() -> None:
    from podcast_mcp.edits import conversation_align, transcript_precorrect, transcript_reconcile
    from podcast_mcp.engines import transcript_align
    from podcast_mcp.util import wer

    for module in (
        conversation_align,
        transcript_align,
        transcript_precorrect,
        transcript_reconcile,
    ):
        assert module.normalize_token is wer.normalize_token

    assert not hasattr(conversation_align, "_norm_token")
    assert not hasattr(transcript_precorrect, "_normalize_token")
    assert not hasattr(transcript_reconcile, "_normalize_token")


def test_word_error_rate_exact_match() -> None:
    r = word_error_rate(["hello", "world"], ["hello", "world"])
    assert r.wer == 0.0
    assert r.errors == 0


def test_word_error_rate_substitution() -> None:
    r = word_error_rate(["documented", "people"], ["documented", "persons"])
    assert r.substitutions == 1
    assert r.wer == 0.5


def test_words_in_windows_filters_outside_speech() -> None:
    ref = [
        TranscriptWord(text="hello", start=2.0, end=3.0),
        TranscriptWord(text="world", start=5.0, end=6.0),
    ]
    windows = speech_windows(ref)
    hyp = [
        TranscriptWord(text="caves", start=4.0, end=5.0),
        TranscriptWord(text="hello", start=2.1, end=2.8),
        TranscriptWord(text="world", start=5.2, end=5.9),
    ]
    kept = words_in_windows(hyp, windows)
    assert [w.text for w in kept] == ["hello", "world"]


def test_accuracy_for_track_uses_windows() -> None:

    ref = [TranscriptWord(text="how", start=23.0, end=23.2)]
    hyp = Transcript(
        track_id="reference",
        language="en",
        words=[
            TranscriptWord(text="noise", start=1.0, end=1.5),
            TranscriptWord(text="how", start=23.05, end=23.15),
        ],
    )
    r = accuracy_for_track(
        track_id="reference",
        reference_words=ref,
        hypothesis=hyp,
    )
    assert r.wer == 0.0
    assert r.hypothesis_text == "how"


def test_tokens_from_text_normalizes_punctuation() -> None:
    assert tokens_from_text("Hello, WORLD!") == ["hello", "world"]


def test_tokens_from_words_skips_empty() -> None:
    words = [
        TranscriptWord(text="...", start=0.0, end=0.1),
        TranscriptWord(text="ok", start=0.2, end=0.3),
    ]
    assert tokens_from_words(words) == ["ok"]


def test_speech_windows_empty_and_gap_split() -> None:
    assert speech_windows([]) == []
    assert speech_windows([TranscriptWord(text="x", start=1.0, end=1.0)]) == []
    words = [
        TranscriptWord(text="a", start=0.0, end=0.5),
        TranscriptWord(text="b", start=2.0, end=2.5),
    ]
    windows = speech_windows(words, gap_sec=0.5, pad_sec=0.1)
    assert len(windows) == 2
    merged = [
        TranscriptWord(text="a", start=0.0, end=0.5),
        TranscriptWord(text="b", start=0.55, end=0.9),
    ]
    assert len(speech_windows(merged, gap_sec=1.0)) == 1


def test_words_in_windows_edge_cases() -> None:
    assert words_in_windows([], []) == []
    word = TranscriptWord(text="x", start=1.0, end=1.0)
    assert words_in_windows([word], [(0.0, 2.0)]) == []


def test_word_error_rate_insertion_and_deletion() -> None:
    ins = word_error_rate(["one"], ["one", "two"])
    assert ins.insertions == 1
    assert ins.deletions == 0
    delete = word_error_rate(["one", "two"], ["one"])
    assert delete.deletions == 1
    assert delete.substitutions == 0


def test_wer_result_errors_property() -> None:
    result = WerResult(
        reference_count=2,
        substitutions=1,
        insertions=0,
        deletions=1,
        wer=1.0,
        reference_text="a b",
        hypothesis_text="a",
    )
    assert result.errors == 2


def test_word_error_rate_empty_reference() -> None:
    result = word_error_rate([], ["hello"])
    assert result.wer is None
    assert result.reference_count == 0


def test_load_ground_truth_words_formats(tmp_path: Path) -> None:
    per_track = tmp_path / "per_track.json"
    per_track.write_text(
        json.dumps(
            {
                "per_track": [
                    {
                        "track_id": "host",
                        "words": [
                            {"text": "hi", "start": 0.0, "end": 0.2},
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    loaded = load_ground_truth_words(per_track)
    assert "host" in loaded
    assert loaded["host"][0].text == "hi"

    single = tmp_path / "single.json"
    single.write_text(
        json.dumps(
            {
                "track_id": "guest",
                "words": [{"text": "yo", "start": 1.0, "end": 1.2}],
            }
        ),
        encoding="utf-8",
    )
    assert load_ground_truth_words(single)["guest"][0].text == "yo"

    bad = tmp_path / "bad.json"
    bad.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="unsupported ground truth"):
        load_ground_truth_words(bad)


def test_load_fixture_transcripts(tmp_path: Path) -> None:
    tx_dir = tmp_path / "transcripts"
    tx_dir.mkdir()
    (tx_dir / "host.json").write_text(
        json.dumps(
            {
                "track_id": "host",
                "words": [{"text": "one", "start": 0.0, "end": 0.5}],
            }
        ),
        encoding="utf-8",
    )
    (tx_dir / "host_combined.json").write_text("{}", encoding="utf-8")
    (tx_dir / "host_deadbeef.json").write_text("{}", encoding="utf-8")
    (tx_dir / "empty.json").write_text("{}", encoding="utf-8")
    loaded = load_fixture_transcripts(tmp_path)
    assert loaded["host"][0].text == "one"


def test_clip_words_to_duration() -> None:
    words = [
        TranscriptWord(text="early", start=0.0, end=1.0),
        TranscriptWord(text="late", start=5.0, end=6.0),
    ]
    clipped = clip_words_to_duration(words, 3.0)
    assert [w.text for w in clipped] == ["early"]
