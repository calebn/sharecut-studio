from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from podcast_mcp.engines.asr_loops import drop_looped_words, zlib_ratio
from podcast_mcp.models import TranscriptWord

LOOP_TEXT = ("And I know that " * 60).split()
VARIED = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
    "mike",
    "november",
    "oscar",
    "papa",
    "quebec",
    "romeo",
    "sierra",
    "tango",
    "uniform",
    "victor",
    "whiskey",
    "xray",
    "yankee",
    "zulu",
]


def _words(texts: list[str], start: float, step: float) -> list[TranscriptWord]:
    return [
        TranscriptWord(text=t, start=start + i * step, end=start + i * step + 0.01)
        for i, t in enumerate(texts)
    ]


def _speech(count: int, start: float, step: float) -> list[TranscriptWord]:
    return _words([f"word{i}" for i in range(count)], start, step)


def test_mac_tail_loop_dropped_and_real_words_kept() -> None:
    real = _speech(20, 294.0, 0.3)
    loop = _words(LOOP_TEXT[:221], 299.84, 0.12 / 221)
    report = drop_looped_words([*real, *loop])
    assert report.kept == real
    assert report.dropped == loop
    assert len(report.dropped) == 221
    assert report.dense_words == 0
    assert report.ratio is not None and report.ratio > 10


def test_fast_real_speech_is_untouched() -> None:
    words = _speech(300, 0.0, 0.1)
    report = drop_looped_words(words)
    assert report.kept == words
    assert report.dropped == []
    assert report.dense_words == 0
    assert report.looped_segments == 0


def test_dense_varied_cram_is_kept_and_counted() -> None:
    cram = _words(VARIED[:20], 10.0, 0.02)
    assert zlib_ratio(" ".join(w.text for w in cram)) < 2.4
    report = drop_looped_words([*_speech(5, 0.0, 0.3), *cram])
    assert len(report.kept) == 25
    assert report.dropped == []
    assert report.dense_words == 20


def test_real_repetition_at_speech_rate_is_untouched() -> None:
    words = _words(["no"] * 6, 3.0, 0.17)
    report = drop_looped_words(words)
    assert report.kept == words
    assert report.dropped == []
    assert report.dense_words == 0


def test_repetitive_but_not_dense_words_are_kept_and_counted_as_looped_segments() -> None:
    words = _words(["no"] * 30, 0.0, 0.33)
    report = drop_looped_words(words, [12.0] * 30)
    assert report.kept == words
    assert report.dropped == []
    assert report.dense_words == 0
    assert report.looped_segments == 1


def test_a_window_whose_loop_was_dropped_is_not_counted_as_looped() -> None:
    real = _speech(10, 290.0, 0.5)
    loop = _words(LOOP_TEXT[:60], 299.0, 0.002)
    report = drop_looped_words([*real, *loop], [14.0] * 70)
    assert report.kept == real
    assert len(report.dropped) == 60
    assert report.looped_segments == 0


def test_window_ratio_corroborates_a_cluster_whose_own_text_is_not_repetitive() -> None:
    cluster = _words(LOOP_TEXT[:14] + LOOP_TEXT[:4], 5.0, 0.03)
    assert zlib_ratio(" ".join(w.text for w in cluster)) < 2.4
    dropped = drop_looped_words(cluster, [12.0] * 18)
    assert dropped.kept == []
    assert len(dropped.dropped) == 18
    kept = drop_looped_words(cluster, [1.8] * 18)
    assert kept.kept == cluster
    assert kept.dropped == []
    assert kept.dense_words == 18


@pytest.mark.parametrize(
    "ratio",
    [None, "12.0", MagicMock(), float("nan"), 2.4],
    ids=["none", "str", "mock", "nan", "at-threshold"],
)
def test_window_ratio_that_is_not_a_real_number_over_the_threshold_is_ignored(ratio) -> None:
    cluster = _words(LOOP_TEXT[:14] + LOOP_TEXT[:4], 5.0, 0.03)
    report = drop_looped_words(cluster, [ratio] * 18)
    assert report.kept == cluster
    assert report.dropped == []
    assert report.dense_words == 18


@pytest.mark.parametrize(
    ("count", "dropped"),
    [(16, 0), (17, 17)],
    ids=["16-words-kept", "17-words-dropped"],
)
def test_density_boundary_is_more_than_16_words_in_one_second(count, dropped) -> None:
    words = _words(["no"] * count, 4.0, 0.05)
    report = drop_looped_words(words)
    assert len(report.dropped) == dropped
    assert len(report.kept) == count - dropped


@pytest.mark.parametrize(
    ("count", "dropped"),
    [(11, 0), (12, 12)],
    ids=["11-words-kept", "12-words-dropped"],
)
def test_a_dense_cluster_needs_at_least_12_words_to_be_dropped(count, dropped) -> None:
    speech = _speech(17 - count, 0.0, 0.12)
    cluster = _words(["no"] * count, 0.9, 0.002)
    assert zlib_ratio(" ".join(w.text for w in cluster)) >= 2.4
    report = drop_looped_words([*speech, *cluster])
    assert report.kept == [*speech, *([] if dropped else cluster)]
    assert len(report.dropped) == dropped
    assert report.dense_words == (0 if dropped else count)


def test_words_at_the_limit_are_never_dropped_whatever_their_window_ratio() -> None:
    words = _words(["no"] * 16, 4.0, 0.0)
    report = drop_looped_words(words, [30.0] * 16)
    assert report.kept == words
    assert report.dropped == []


def test_second_pass_finds_nothing() -> None:
    real = _speech(10, 290.0, 0.5)
    loop = _words(LOOP_TEXT[:100], 299.0, 0.001)
    first = drop_looped_words([*real, *loop])
    second = drop_looped_words(first.kept)
    assert second.kept == first.kept
    assert second.dropped == []


def test_empty_single_and_zero_duration_words() -> None:
    assert drop_looped_words([]).kept == []
    one = [TranscriptWord(text="hi", start=1.0, end=1.0)]
    assert drop_looped_words(one).kept == one
    stacked = [TranscriptWord(text="no", start=2.0, end=2.0) for _ in range(30)]
    report = drop_looped_words(stacked)
    assert report.dropped == stacked
    assert report.kept == []


def test_zlib_ratio_matches_the_whisper_formula() -> None:
    assert zlib_ratio("") == 0.0
    assert zlib_ratio(" ".join(LOOP_TEXT)) > 10
    assert zlib_ratio(" ".join(VARIED)) < 1.5
