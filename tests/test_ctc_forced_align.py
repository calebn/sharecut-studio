from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines.ctc_forced_align import (
    AlignmentWindow,
    CtcVocab,
    align_words,
    ctc_viterbi,
    log_softmax,
    plan_windows,
)

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
