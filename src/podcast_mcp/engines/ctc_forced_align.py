"""Numpy-only CTC forced alignment of known words over frame log-probabilities.

Shared by the opt-in pipeline pass (``engines/word_align.py``, #714) and
``scripts/benchmark_forced_aligners.py``. ``retime_spans_stream`` (#730) reads
windows through a forward-only ``SequentialWindowReader`` so a caller never
needs the whole decode resident at once; ``retime_spans`` wraps it for
callers that already hold a full in-memory array. ``place_words`` /
``place_spans_stream`` additionally return each word's mean emitting-frame
posterior, which the pipeline uses as a hallucination signal (#195).
"""

from __future__ import annotations

import contextlib
import math
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from itertools import pairwise
from typing import Protocol

import numpy as np

from podcast_mcp.util.pcm_stream import SequentialWindowReader

FRAME_SEC_WAV2VEC2 = 0.02  # wav2vec2 conv stride: 320 samples @ 16 kHz
SAMPLE_RATE_WAV2VEC2 = 16_000
# wav2vec2's feature encoder needs 400 samples (25 ms) for one frame.
MIN_WINDOW_SAMPLES = 400
DEFAULT_MAX_GAP_SEC = 1.0
DEFAULT_MAX_WINDOW_SEC = 20.0
DEFAULT_PAD_SEC = 0.5
# Bump when the per-word score definition changes: part of WordAligner.cache_identity and
# stored as Transcript.alignment_score_method, so stored transcripts count as not re-timed.
ALIGNMENT_SCORE_METHOD = "mean_emitting_posterior_v1"


class LogProbBackend(Protocol):
    """Frame log-probabilities (T x vocab) for a mono float32 chunk at 16 kHz."""

    def log_probs(self, samples: np.ndarray) -> np.ndarray: ...


def normalize_waveform(samples: np.ndarray) -> np.ndarray:
    """Zero-mean / unit-variance input, as wav2vec2's feature extractor does."""
    return (samples - samples.mean()) / np.sqrt(samples.var() + 1e-7)


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


@dataclass(frozen=True)
class PlacedWord:
    """A force-aligned word: its span and the mean posterior of the frames that emit it (0..1)."""

    start: float
    end: float
    score: float


def place_words(
    log_probs: np.ndarray,
    words: Sequence[str],
    vocab: CtcVocab,
    *,
    frame_sec: float = FRAME_SEC_WAV2VEC2,
    offset_sec: float = 0.0,
) -> list[PlacedWord | None]:
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
    results: list[PlacedWord | None] = [None] * len(words)
    if path is None:
        return results

    first_frame: dict[int, int] = {}
    last_frame: dict[int, int] = {}
    evidence: dict[int, list[float]] = {}
    for frame, state in enumerate(path):
        if state < 0:
            continue
        word_index = owner[state]
        if word_index < 0:
            continue
        if word_index not in first_frame:
            first_frame[word_index] = frame
        last_frame[word_index] = frame
        evidence.setdefault(word_index, []).append(float(np.exp(log_probs[frame, targets[state]])))

    for word_index, first in first_frame.items():
        last = last_frame[word_index]
        scores = evidence[word_index]
        results[word_index] = PlacedWord(
            round(offset_sec + first * frame_sec, 4),
            round(offset_sec + (last + 1) * frame_sec, 4),
            round(sum(scores) / len(scores), 4),
        )
    return results


def align_words(
    log_probs: np.ndarray,
    words: Sequence[str],
    vocab: CtcVocab,
    *,
    frame_sec: float = FRAME_SEC_WAV2VEC2,
    offset_sec: float = 0.0,
) -> list[tuple[float, float] | None]:
    """Spans only; see :func:`place_words` for the per-word evidence score."""
    return [
        None if p is None else (p.start, p.end)
        for p in place_words(log_probs, words, vocab, frame_sec=frame_sec, offset_sec=offset_sec)
    ]


@dataclass(frozen=True)
class AlignmentWindow:
    start_sec: float
    end_sec: float
    word_indices: tuple[int, ...]


def plan_windows(
    spans: Sequence[tuple[float, float]],
    *,
    audio_sec: float = math.inf,
    max_gap_sec: float = DEFAULT_MAX_GAP_SEC,
    max_window_sec: float = DEFAULT_MAX_WINDOW_SEC,
    pad_sec: float = DEFAULT_PAD_SEC,
) -> list[AlignmentWindow]:
    """Group word spans into padded alignment windows.

    ``spans`` must be sorted by start time (ties allowed): grouping is a single
    left-to-right pass. Windows split on gaps over ``max_gap_sec`` or spans over
    ``max_window_sec`` and never pad across the midpoint to the next window.
    A single span longer than ``max_window_sec`` is not split: it gets its own
    window, as long as the span plus padding.
    ``audio_sec`` defaults to unbounded: only the padded right edge is clamped
    to it, so a caller that streams the decode (``retime_spans_stream``) can
    plan windows before it knows the media's length and let the reader clamp
    the final window at EOF instead.
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
        # An inverted span (end < start) can push mid before this window's own
        # padded left edge; never let a later window start earlier than an
        # earlier one (the reader is forward-only).
        padded[i + 1] = (min(max(nleft, mid, padded[i][0]), next_first_start), nright)

    windows: list[AlignmentWindow] = []
    for group, (start, end) in zip(groups, padded, strict=True):
        windows.append(AlignmentWindow(start_sec=start, end_sec=end, word_indices=tuple(group)))
    return windows


@dataclass(frozen=True)
class RetimeStats:
    windows: int
    failed_windows: int
    aligned_words: int
    unaligned_words: int

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


def retime_spans(
    samples: np.ndarray,
    words: Sequence[tuple[str, float, float]],
    backend: LogProbBackend,
    vocab: CtcVocab,
    *,
    sample_rate: int = SAMPLE_RATE_WAV2VEC2,
) -> tuple[list[tuple[float, float] | None], RetimeStats]:
    """Force-align ``(text, start, end)`` words in padded windows around their current spans.

    Returns one span per input word (None = not placed; the caller keeps the old
    times). Windows shorter than MIN_WINDOW_SAMPLES (e.g. words past the end of
    the audio) count as failed without calling the backend. Wraps
    :func:`retime_spans_stream` over a single-chunk reader; prefer that
    function when the decode is already being streamed.
    """
    with contextlib.closing(SequentialWindowReader([samples], sample_rate)) as reader:
        return retime_spans_stream(reader, words, backend, vocab)


def place_spans_stream(
    reader: SequentialWindowReader,
    words: Sequence[tuple[str, float, float]],
    backend: LogProbBackend,
    vocab: CtcVocab,
) -> tuple[list[PlacedWord | None], RetimeStats]:
    """``retime_spans_stream``, but returning each placed word's evidence score too.

    Windows are planned without an ``audio_sec`` bound; the reader clamps
    each window's samples at EOF, so the result is identical to a whole-file
    decode (#730). Resident audio is one planned window plus one reader
    chunk; windows are at most ``max_window_sec`` plus padding except around
    a single overlong word span (see :func:`plan_windows`).
    """
    sample_rate = reader.sample_rate
    order = sorted(range(len(words)), key=lambda i: words[i][1])
    windows = plan_windows([(words[i][1], words[i][2]) for i in order])
    placed: list[PlacedWord | None] = [None] * len(words)
    failed = 0
    for win in windows:
        indices = [order[j] for j in win.word_indices]
        chunk, _ = reader.window_samples(
            round(win.start_sec * sample_rate), round(win.end_sec * sample_rate)
        )
        if chunk.size < MIN_WINDOW_SAMPLES:
            failed += 1
            continue
        lp = backend.log_probs(chunk)
        window_placed = place_words(
            lp, [words[i][0] for i in indices], vocab, offset_sec=win.start_sec
        )
        if all(p is None for p in window_placed):
            failed += 1
        for index, p in zip(indices, window_placed, strict=True):
            if p is not None:
                placed[index] = p
    aligned = sum(p is not None for p in placed)
    return placed, RetimeStats(
        windows=len(windows),
        failed_windows=failed,
        aligned_words=aligned,
        unaligned_words=len(words) - aligned,
    )


def retime_spans_stream(
    reader: SequentialWindowReader,
    words: Sequence[tuple[str, float, float]],
    backend: LogProbBackend,
    vocab: CtcVocab,
) -> tuple[list[tuple[float, float] | None], RetimeStats]:
    """``retime_spans``, but pulling windows from a forward-only ``SequentialWindowReader``.

    Spans only; see :func:`place_spans_stream` for the per-word evidence score.
    """
    placed, stats = place_spans_stream(reader, words, backend, vocab)
    return [None if p is None else (p.start, p.end) for p in placed], stats
