"""Numpy-only CTC forced alignment of known words over frame log-probabilities.

Benchmark harness only (#640/#641); integration is #639.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise

import numpy as np

FRAME_SEC_WAV2VEC2 = 0.02  # wav2vec2 conv stride: 320 samples @ 16 kHz


@dataclass(frozen=True)
class CtcVocab:
    """A CTC character vocabulary: token id lookup, blank id and word delimiter."""

    ids: Mapping[str, int]
    blank_id: int
    delimiter_id: int | None

    @classmethod
    def from_token_map(
        cls, token_map: Mapping[str, int], *, blank: str = "<pad>", delimiter: str | None = "|"
    ) -> CtcVocab:
        if blank not in token_map:
            raise ValueError(f"CTC vocab has no blank token {blank!r}")
        delimiter_id = token_map.get(delimiter) if delimiter else None
        return cls(ids=token_map, blank_id=token_map[blank], delimiter_id=delimiter_id)

    def encode_word(self, text: str) -> list[int]:
        """Encode a word's alignable characters, dropping any without a token.

        NFKD normalization plus uppercasing means combining marks fall out of
        the vocabulary and a character like "Á" degrades to "A" rather than
        being dropped outright.
        """
        normalized = unicodedata.normalize("NFKD", text).replace("\u2019", "'").upper()
        skip = {self.blank_id, self.delimiter_id}
        return [self.ids[ch] for ch in normalized if ch in self.ids and self.ids[ch] not in skip]


def log_softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    return shifted - np.log(np.exp(shifted).sum(axis=-1, keepdims=True))


def ctc_viterbi(log_probs: np.ndarray, targets: Sequence[int], blank_id: int) -> np.ndarray | None:
    """Best CTC path forced through ``targets``.

    Returns an int array of length T: the target index for frames that emit a
    target, -1 for blank frames. None when targets is empty, when
    T < len(targets) + (count of adjacent equal targets), or when the best
    final score is -inf.
    """
    if not targets:
        return None
    targets = list(targets)
    length = len(targets)
    ext = np.empty(2 * length + 1, dtype=np.int64)
    ext[0::2] = blank_id
    ext[1::2] = targets
    states = ext.shape[0]

    skip = np.zeros(states, dtype=bool)
    skip[2:] = (ext[2:] != blank_id) & (ext[2:] != ext[:-2])

    frames = log_probs.shape[0]

    dp = np.full(states, -np.inf)
    dp[0] = log_probs[0, blank_id]
    dp[1] = log_probs[0, ext[1]]
    back = np.zeros((frames, states), dtype=np.int8)

    for t in range(1, frames):
        stay = dp
        prev1 = np.concatenate(([-np.inf], dp[:-1]))
        prev2 = np.where(skip, np.concatenate(([-np.inf, -np.inf], dp[:-2])), -np.inf)
        stacked = np.stack([stay, prev1, prev2], axis=0)
        step = np.argmax(stacked, axis=0)
        back[t] = step
        dp = stacked[step, np.arange(states)] + log_probs[t, ext]

    final_state = states - 1 if dp[states - 1] >= dp[states - 2] else states - 2
    if dp[final_state] == -np.inf:
        return None

    path = np.full(frames, -1, dtype=np.int64)
    state = final_state
    for t in range(frames - 1, -1, -1):
        if state % 2 == 1:
            path[t] = (state - 1) // 2
        if t > 0:
            state -= int(back[t, state])
    return path


def align_words(
    log_probs: np.ndarray,
    words: Sequence[str],
    vocab: CtcVocab,
    *,
    frame_sec: float = FRAME_SEC_WAV2VEC2,
    offset_sec: float = 0.0,
) -> list[tuple[float, float] | None]:
    targets: list[int] = []
    owner: list[int] = []
    encodings: dict[int, list[int]] = {}
    for index, word in enumerate(words):
        encoded = vocab.encode_word(word)
        if encoded:
            encodings[index] = encoded

    encoded_indices = sorted(encodings)
    for position, index in enumerate(encoded_indices):
        if position > 0 and vocab.delimiter_id is not None:
            targets.append(vocab.delimiter_id)
            owner.append(-1)
        for token in encodings[index]:
            targets.append(token)
            owner.append(index)

    path = ctc_viterbi(log_probs, targets, vocab.blank_id)
    results: list[tuple[float, float] | None] = [None] * len(words)
    if path is None:
        return results

    first_frame: dict[int, int] = {}
    last_frame: dict[int, int] = {}
    for frame, state in enumerate(path):
        if state < 0:
            continue
        word_index = owner[state]
        if word_index < 0:
            continue
        if word_index not in first_frame:
            first_frame[word_index] = frame
        last_frame[word_index] = frame

    for word_index, first in first_frame.items():
        last = last_frame[word_index]
        results[word_index] = (
            round(offset_sec + first * frame_sec, 4),
            round(offset_sec + (last + 1) * frame_sec, 4),
        )
    return results


@dataclass(frozen=True)
class AlignmentWindow:
    start_sec: float
    end_sec: float
    word_indices: tuple[int, ...]


def plan_windows(
    spans: Sequence[tuple[float, float]],
    *,
    audio_sec: float,
    max_gap_sec: float = 1.0,
    max_window_sec: float = 20.0,
    pad_sec: float = 0.5,
) -> list[AlignmentWindow]:
    """Group word spans into padded alignment windows.

    ``spans`` must be sorted by start time (ties allowed): grouping is a single
    left-to-right pass. Windows split on gaps over ``max_gap_sec`` or spans over
    ``max_window_sec`` and never pad across the midpoint to the next window.
    """
    if not spans:
        return []
    if any(later[0] < earlier[0] for earlier, later in pairwise(spans)):
        raise ValueError("plan_windows needs spans sorted by start time")

    groups: list[list[int]] = []
    group_first_start = 0.0
    group_max_end = 0.0
    for index, (start, end) in enumerate(spans):
        needs_new_group = groups and (
            start - group_max_end > max_gap_sec or end - group_first_start > max_window_sec
        )
        if needs_new_group or not groups:
            groups.append([])
        group = groups[-1]
        if not group:
            group_first_start = start
            group_max_end = end
        else:
            group_max_end = max(group_max_end, end)
        group.append(index)

    bounds: list[tuple[float, float]] = []
    for group in groups:
        starts = [spans[i][0] for i in group]
        ends = [spans[i][1] for i in group]
        bounds.append((min(starts), max(ends)))

    padded: list[tuple[float, float]] = []
    for first_start, max_end in bounds:
        left = max(0.0, first_start - pad_sec)
        right = min(audio_sec, max_end + pad_sec)
        padded.append((left, right))

    for i in range(len(padded) - 1):
        prev_max_end = bounds[i][1]
        next_first_start = bounds[i + 1][0]
        mid = (prev_max_end + next_first_start) / 2
        left, right = padded[i]
        # Overlapping word spans can push the unpadded bound past the
        # midpoint; never clamp tighter than the words themselves.
        padded[i] = (left, max(min(right, mid), prev_max_end))
        nleft, nright = padded[i + 1]
        padded[i + 1] = (min(max(nleft, mid), next_first_start), nright)

    windows: list[AlignmentWindow] = []
    for group, (start, end) in zip(groups, padded, strict=True):
        windows.append(AlignmentWindow(start_sec=start, end_sec=end, word_indices=tuple(group)))
    return windows
