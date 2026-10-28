from __future__ import annotations

import zlib
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


def test_tail_loop_dropped_and_real_words_kept() -> None:
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
    text = "abc " * 40
    data = text.encode()
    assert zlib_ratio(text) == len(data) / len(zlib.compress(data))
    assert zlib_ratio("") == 0.0


def test_looped_segments_count_windows_not_distinct_ratios() -> None:
    words = [*_words(["a"] * 3, 0.0, 2.0), *_words(["b"] * 3, 10.0, 2.0)]
    assert drop_looped_words(words, [3.0] * 6).looped_segments == 2
    assert drop_looped_words(words, [3.0] * 3 + [3.5] * 3).looped_segments == 2
    assert drop_looped_words(words[:3], [3.0] * 3).looped_segments == 1


def test_window_gap_boundary_and_reset_between_same_ratio_words() -> None:
    def count(second_start: float) -> int:
        words = [*_words(["a"], 0.0, 0.0), *_words(["b"], second_start, 0.0)]
        return drop_looped_words(words, [3.0, 3.0]).looped_segments

    assert count(5.0) == 1
    assert count(5.1) == 2
    mixed = [*_words(["a"], 0.0, 0.0), *_words(["b"], 1.0, 0.0), *_words(["c"], 2.0, 0.0)]
    assert drop_looped_words(mixed, [3.0, 1.0, 3.0]).looped_segments == 2


def test_a_real_word_between_two_loop_runs_is_kept() -> None:
    first = _words(LOOP_TEXT[:20], 10.0, 0.03)
    stop = _words(["stop"], 10.8, 0.0)
    second = _words(LOOP_TEXT[:20], 11.0, 0.03)
    report = drop_looped_words([*first, *stop, *second])
    assert report.kept == stop
    assert report.dropped == [*first, *second]


def test_a_real_word_after_a_loop_run_is_kept_and_a_short_second_run_is_not_dense() -> None:
    first = _words(LOOP_TEXT[:20], 10.0, 0.05)
    stop = _words(["stop"], 11.2, 0.0)
    tail = _words(LOOP_TEXT[:10], 11.3, 0.05)
    report = drop_looped_words([*first, *stop, *tail])
    assert report.dropped == first
    assert report.kept == [*stop, *tail]
    assert report.dense_words == 0


def test_a_real_word_just_before_a_loop_run_goes_with_it() -> None:
    yes = _words(["yes"], 9.95, 0.0)
    loop = _words(LOOP_TEXT[:20], 10.0, 0.05)
    report = drop_looped_words([*yes, *loop])
    assert report.dropped == [*yes, *loop]


def test_clean_words_beside_a_squeezed_loop_survive() -> None:
    clean = _speech(25, 0.0, 0.4)
    loop = _words(LOOP_TEXT[:40], 10.0, 0.05)
    report = drop_looped_words([*clean, *loop])
    assert report.kept == clean
    assert report.dropped == loop


def test_a_real_word_that_starts_inside_a_squeezed_run_goes_with_it() -> None:
    inside = _words(["real"], 10.4, 0.0)
    loop = _words(LOOP_TEXT[:40], 10.0, 0.05)
    report = drop_looped_words([*loop, *inside])
    assert report.kept == []


def test_window_ratio_also_drops_a_dense_run_of_ordinary_words() -> None:
    cluster = _words([f"word{i}" for i in range(18)], 5.0, 0.05)
    assert zlib_ratio(" ".join(w.text for w in cluster)) < 2.4
    assert drop_looped_words(cluster, [2.5] * 18).dropped == cluster
    assert drop_looped_words(cluster).dropped == []
