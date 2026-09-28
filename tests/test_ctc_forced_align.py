from __future__ import annotations

import contextlib
import inspect
import math
from itertools import pairwise

import numpy as np
import pytest

from ctc_fakes import HI_BYE_HOT, HI_BYE_TOKENS, FakeBackend
from podcast_mcp.engines.ctc_forced_align import (
    DEFAULT_MAX_GAP_SEC,
    DEFAULT_MAX_WINDOW_SEC,
    DEFAULT_PAD_SEC,
    MIN_WINDOW_SAMPLES,
    AlignmentWindow,
    CtcVocab,
    RetimeStats,
    align_words,
    ctc_viterbi,
    log_softmax,
    normalize_waveform,
    plan_windows,
    retime_spans,
    retime_spans_stream,
)
from podcast_mcp.util.pcm_stream import SequentialWindowReader

VOCAB = CtcVocab.from_token_map({"<pad>": 0, "|": 1, "A": 2, "B": 3, "'": 4})


def emissions(t: int, hot: dict[int, int], v: int = 5) -> np.ndarray:
    lp = np.full((t, v), np.log(0.01))
    lp[:, 0] = np.log(0.9)
    for frame, token in hot.items():
        lp[frame, :] = np.log(0.01)
        lp[frame, token] = np.log(0.9)
    return lp


def test_vocab_encodes_letters_apostrophes_and_drops_unalignable() -> None:
    assert VOCAB.encode_word("ab\u2019") == [2, 3, 4]
    assert VOCAB.encode_word("42") == []
    assert VOCAB.encode_word("\u00c1") == [2]
    with pytest.raises(ValueError):
        CtcVocab.from_token_map({"A": 1})
    no_delim = CtcVocab.from_token_map({"<pad>": 0, "A": 2}, delimiter=None)
    assert no_delim.delimiter_id is None


def test_viterbi_returns_exact_frames_for_known_emissions() -> None:
    lp = emissions(10, {2: 2, 3: 2, 6: 3})
    path = ctc_viterbi(lp, [2, 3], blank_id=0)
    assert path is not None
    assert path.tolist() == [-1, -1, 0, 0, -1, -1, 1, -1, -1, -1]


def test_viterbi_repeated_token_needs_blank_between() -> None:
    assert ctc_viterbi(emissions(2, {}), [2, 2], blank_id=0) is None

    lp = emissions(3, {0: 2, 2: 2})
    path = ctc_viterbi(lp, [2, 2], blank_id=0)
    assert path is not None
    assert path.tolist() == [0, -1, 1]


def test_viterbi_empty_targets_or_impossible_scores_return_none() -> None:
    assert ctc_viterbi(emissions(5, {}), [], blank_id=0) is None

    lp = emissions(3, {})
    lp[:, 2] = -np.inf
    assert ctc_viterbi(lp, [2], blank_id=0) is None


def test_align_words_exact_boundaries_with_offset() -> None:
    lp = emissions(10, {2: 2, 3: 3, 5: 1, 7: 3})
    result = align_words(lp, ["ab", "42", "b"], VOCAB, offset_sec=1.0)
    assert result == [(1.04, 1.08), None, (1.14, 1.16)]


def test_align_words_infeasible_window_returns_all_none() -> None:
    lp = emissions(1, {})
    result = align_words(lp, ["ab", "b"], VOCAB)
    assert result == [None, None]


def test_log_softmax_normalizes_large_logits() -> None:
    logits = np.array([[1e4, 1e4 + 1, 1e4 - 1]])
    out = log_softmax(logits)
    assert np.all(np.isfinite(out))
    assert np.exp(out).sum(axis=-1) == pytest.approx(1.0)


def test_plan_windows_splits_on_gap() -> None:
    windows = plan_windows([(0.0, 0.2), (2.0, 2.2)], audio_sec=5.0, pad_sec=0.0)
    assert len(windows) == 2
    assert windows[0].word_indices == (0,)
    assert windows[1].word_indices == (1,)


def test_plan_windows_splits_on_max_window_length() -> None:
    windows = plan_windows(
        [(0.0, 0.2), (15.0, 15.2), (25.0, 25.2)], audio_sec=30.0, max_gap_sec=100.0, pad_sec=0.0
    )
    assert [w.word_indices for w in windows] == [(0, 1), (2,)]


def test_plan_windows_pads_and_clamps_to_audio_bounds() -> None:
    windows = plan_windows([(0.1, 0.2)], audio_sec=0.5, pad_sec=1.0)
    assert windows == [AlignmentWindow(start_sec=0.0, end_sec=0.5, word_indices=(0,))]


def test_plan_windows_adjacent_splits_do_not_cross_midpoint() -> None:
    windows = plan_windows([(0.0, 1.0), (3.0, 4.0)], audio_sec=10.0, max_gap_sec=1.5, pad_sec=2.0)
    mid = (1.0 + 3.0) / 2
    assert windows[0].end_sec == pytest.approx(mid)
    assert windows[1].start_sec == pytest.approx(mid)


def test_plan_windows_empty_input_returns_empty_list() -> None:
    assert plan_windows([], audio_sec=10.0) == []


def test_plan_windows_rejects_unsorted_spans_but_allows_ties() -> None:
    with pytest.raises(ValueError, match="sorted"):
        plan_windows([(1.0, 1.2), (0.0, 0.2)], audio_sec=5.0)
    windows = plan_windows([(0.0, 0.2), (0.0, 0.3)], audio_sec=5.0, pad_sec=0.0)
    assert [w.word_indices for w in windows] == [(0, 1)]


def test_plan_windows_single_overlong_word_gets_its_own_window() -> None:
    windows = plan_windows(
        [(0.0, 25.0), (25.5, 25.8)], audio_sec=30.0, max_window_sec=20.0, pad_sec=0.0
    )
    assert [w.word_indices for w in windows] == [(0,), (1,)]


def test_plan_windows_overlapping_words_keep_unpadded_bounds() -> None:
    windows = plan_windows(
        [(0.0, 2.0), (1.0, 3.0)], audio_sec=10.0, max_window_sec=1.5, pad_sec=1.0
    )
    assert len(windows) == 2
    assert windows[0].end_sec == pytest.approx(2.0)
    assert windows[1].start_sec == pytest.approx(1.0)


def test_retime_spans_places_words_in_start_order_and_counts_unaligned() -> None:
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    words = [("hi", 0.0, 0.5), ("42", 0.5, 0.7), ("bye", 0.7, 1.2)]
    samples = np.zeros(round(1.2 * 16000), dtype=np.float32)

    spans, stats = retime_spans(samples, words, backend, vocab)

    assert spans[0] == pytest.approx((0.0, 0.04))
    assert spans[1] is None
    assert spans[2] == pytest.approx((0.08, 0.14))
    assert stats == RetimeStats(windows=1, failed_windows=0, aligned_words=2, unaligned_words=1)


def test_retime_spans_skips_windows_too_short_for_the_model() -> None:
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)

    class ExplodingBackend:
        def log_probs(self, samples: np.ndarray) -> np.ndarray:
            raise AssertionError("backend should not be called for a too-short window")

    samples = np.zeros(round(0.1 * 16000), dtype=np.float32)
    spans, stats = retime_spans(samples, [("hi", 5.0, 5.2)], ExplodingBackend(), vocab)

    assert spans == [None]
    assert stats.failed_windows == 1
    assert stats.aligned_words == 0


def test_retime_spans_counts_a_window_with_no_placed_word_as_failed() -> None:
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, hot={}, frames=1, vocab_size=7)
    samples = np.zeros(round(0.5 * 16000), dtype=np.float32)

    _spans, stats = retime_spans(samples, [("bye", 0.0, 0.5)], backend, vocab)

    assert stats.failed_windows == 1


def test_normalize_waveform_is_zero_mean_unit_variance() -> None:
    rng = np.random.default_rng(0)
    samples = (rng.standard_normal(1000).astype(np.float32) * 5) + 3

    normalized = normalize_waveform(samples)

    assert normalized.mean() == pytest.approx(0.0, abs=1e-5)
    assert normalized.var() == pytest.approx(1.0, abs=1e-3)


def test_plan_windows_defaults_are_the_shared_constants() -> None:
    params = inspect.signature(plan_windows).parameters
    assert params["max_gap_sec"].default == DEFAULT_MAX_GAP_SEC
    assert params["max_window_sec"].default == DEFAULT_MAX_WINDOW_SEC
    assert params["pad_sec"].default == DEFAULT_PAD_SEC


def test_plan_windows_without_audio_sec_does_not_clamp_the_end() -> None:
    assert inspect.signature(plan_windows).parameters["audio_sec"].default == math.inf

    windows = plan_windows([(0.0, 0.2)], pad_sec=1.0)

    assert windows == [AlignmentWindow(start_sec=0.0, end_sec=1.2, word_indices=(0,))]


def test_plan_windows_starts_never_decrease_for_inverted_spans() -> None:
    # Before the fix, this gave starts 0, 5.75, 4.0 — the last one earlier than
    # the previous, which would make the forward-only reader raise.
    windows = plan_windows([(0.0, 5.0), (6.5, 0.0), (7.0, 7.1)], pad_sec=3.0)
    starts = [w.start_sec for w in windows]

    assert starts == pytest.approx([0.0, 5.75, 5.75])

    rng = np.random.default_rng(20240730)
    for _ in range(200):
        n = int(rng.integers(1, 8))
        starts_in = np.sort(rng.uniform(0.0, 50.0, size=n))
        # end - start is allowed to go negative: an inverted span.
        offsets = rng.uniform(-5.0, 15.0, size=n)
        spans = [(float(s), float(s + o)) for s, o in zip(starts_in, offsets, strict=True)]
        pad_sec = float(rng.uniform(0.0, 5.0))
        max_gap_sec = float(rng.uniform(0.1, 5.0))
        max_window_sec = float(rng.uniform(1.0, 30.0))

        windows = plan_windows(
            spans, pad_sec=pad_sec, max_gap_sec=max_gap_sec, max_window_sec=max_window_sec
        )
        win_starts = [w.start_sec for w in windows]

        assert all(b >= a for a, b in pairwise(win_starts))
        for window in windows:
            first_word_start = spans[window.word_indices[0]][0]
            assert window.start_sec <= first_word_start + 1e-9


def test_retime_spans_stream_matches_legacy_whole_file_slices() -> None:
    sr = 16000
    dur = 95.0
    rng = np.random.default_rng(7)
    samples = (rng.standard_normal(round(dur * sr)).astype(np.float32)) * 0.01

    words: list[tuple[str, float, float]] = []
    t = 0.0
    while t < 60.0:
        words.append(("hi", t, t + 0.3))
        t += 2.0
    for t in (79.0, 79.5, 80.0):  # a gapped group near 80s
        words.append(("bye", t, t + 0.2))
    words.append(("hi", 94.5, 96.0))  # straddles EOF
    words.append(("bye", 97.0, 97.3))  # entirely past EOF

    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)

    class RecordingBackend:
        def __init__(self, inner: FakeBackend) -> None:
            self._inner = inner
            self.calls: list[np.ndarray] = []

        def log_probs(self, samples: np.ndarray) -> np.ndarray:
            self.calls.append(samples.copy())
            return self._inner.log_probs(samples)

    def chunks(size: int = 4001) -> list[np.ndarray]:
        return [samples[i : i + size] for i in range(0, samples.size, size)]

    legacy_backend = RecordingBackend(FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7))
    legacy_spans, legacy_stats = retime_spans(samples, words, legacy_backend, vocab, sample_rate=sr)

    stream_backend = RecordingBackend(FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7))
    with contextlib.closing(SequentialWindowReader(chunks(), sr)) as reader:
        stream_spans, stream_stats = retime_spans_stream(reader, words, stream_backend, vocab)

    assert legacy_spans == stream_spans
    assert legacy_stats == stream_stats
    assert len(legacy_backend.calls) == len(stream_backend.calls)
    for legacy_chunk, stream_chunk in zip(legacy_backend.calls, stream_backend.calls, strict=True):
        np.testing.assert_array_equal(legacy_chunk, stream_chunk)

    # Cross-check against the legacy whole-file-slice computation directly.
    order = sorted(range(len(words)), key=lambda i: words[i][1])
    legacy_windows = plan_windows([(words[i][1], words[i][2]) for i in order], audio_sec=dur)
    expected_calls = []
    for win in legacy_windows:
        start_sample = round(win.start_sec * sr)
        end_sample = round(win.end_sec * sr)
        if end_sample - start_sample < MIN_WINDOW_SAMPLES:
            continue
        expected_calls.append(samples[start_sample:end_sample])
    assert len(expected_calls) == len(legacy_backend.calls)
    for expected, actual in zip(expected_calls, legacy_backend.calls, strict=True):
        np.testing.assert_array_equal(expected, actual)


def test_retime_spans_stream_keeps_resident_audio_to_one_window() -> None:
    sr = 16000
    dur = 200.0
    rng = np.random.default_rng(3)
    samples = (rng.standard_normal(round(dur * sr)).astype(np.float32)) * 0.01
    words: list[tuple[str, float, float]] = []
    t = 0.0
    while t < dur - 1.0:
        words.append(("hi", t, t + 0.3))
        t += 0.5

    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)
    chunk_size = 5000

    def chunks() -> list[np.ndarray]:
        return [samples[i : i + chunk_size] for i in range(0, samples.size, chunk_size)]

    reader = SequentialWindowReader(chunks(), sr)
    original_window_samples = reader.window_samples
    peaks: list[int] = []

    def tracked(start: int, end: int) -> tuple[np.ndarray, int]:
        result = original_window_samples(start, end)
        peaks.append(reader.buffered_samples)
        return result

    reader.window_samples = tracked  # type: ignore[method-assign]

    with contextlib.closing(reader):
        retime_spans_stream(reader, words, backend, vocab)

    bound = round((DEFAULT_MAX_WINDOW_SEC + 2 * DEFAULT_PAD_SEC) * sr) + 2 + chunk_size
    assert max(peaks) <= bound


def test_retime_spans_stream_handles_inverted_spans_without_raising() -> None:
    sr = 16000
    samples = np.zeros(round(20.0 * sr), dtype=np.float32)
    words = [("hi", 0.0, 5.0), ("bye", 6.5, 0.0), ("hi", 7.0, 7.1)]
    vocab = CtcVocab.from_token_map(HI_BYE_TOKENS)
    backend = FakeBackend(vocab, HI_BYE_HOT, frames=7, vocab_size=7)

    with contextlib.closing(SequentialWindowReader([samples], sr)) as reader:
        spans, stats = retime_spans_stream(reader, words, backend, vocab)

    assert len(spans) == 3
    assert stats.windows >= 1
