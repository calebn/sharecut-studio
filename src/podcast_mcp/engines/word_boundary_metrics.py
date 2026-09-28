"""Compare word timestamps with an independently timed reference transcript."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from math import ceil, isfinite
from typing import Any

MAX_BENCHMARK_WORDS = 256

# #715: the sensitivity table for DEFAULT_MAX_WORD_DURATION_SEC re-tuning.
DURATION_THRESHOLDS_SEC = (1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5)


def _key(text: str) -> str:
    return re.sub(r"[^\w]", "", text.casefold())


@dataclass(frozen=True)
class BoundaryMetrics:
    reference_words: int
    predicted_words: int
    matched_words: int
    missed_reference_words: int
    extra_predicted_words: int
    boundary_mae_ms: float | None
    # Signed mean(prediction - reference), in milliseconds, over matched
    # words only. CTC forced alignment tends to start late and end early, so
    # this bias is what #641/#639 use to tune boundary padding.
    mean_start_error_ms: float | None  # positive = starts late
    mean_end_error_ms: float | None  # negative = ends early (clipped tail)
    words_over_150ms: int
    words_over_150ms_fraction: float | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def measure_word_boundaries(
    reference: list[dict[str, Any]], prediction: list[dict[str, Any]]
) -> BoundaryMetrics:
    """Measure matching words only; count insertions/deletions separately.

    ``boundary_mae_ms`` averages the absolute start and end errors. A word is
    over 150 ms when either boundary is off by strictly more than 150 ms.
    Exact monotone sequence matching first maximizes matched text and then
    minimizes total boundary error. The benchmark accepts short clips of at
    most 256 words per side to bound alignment time and traceback memory.
    """
    pairs = matched_word_pairs(reference, prediction)
    errors = [
        (abs(ref["start"] - pred["start"]), abs(ref["end"] - pred["end"])) for ref, pred in pairs
    ]
    over = sum(start > 0.150 or end > 0.150 for start, end in errors)
    matched = len(pairs)
    return BoundaryMetrics(
        reference_words=len(reference),
        predicted_words=len(prediction),
        matched_words=matched,
        missed_reference_words=len(reference) - matched,
        extra_predicted_words=len(prediction) - matched,
        boundary_mae_ms=(
            1000 * sum(start + end for start, end in errors) / (2 * matched) if matched else None
        ),
        mean_start_error_ms=(
            1000 * sum(pred["start"] - ref["start"] for ref, pred in pairs) / matched
            if matched
            else None
        ),
        mean_end_error_ms=(
            1000 * sum(pred["end"] - ref["end"] for ref, pred in pairs) / matched
            if matched
            else None
        ),
        words_over_150ms=over,
        words_over_150ms_fraction=over / matched if matched else None,
    )


@dataclass(frozen=True)
class DurationProfile:
    """Word-duration distribution, for the DEFAULT_MAX_WORD_DURATION_SEC sensitivity table (#715)."""

    words: int
    max_sec: float | None
    p95_sec: float | None
    p99_sec: float | None
    # threshold (e.g. "1.50") -> count of words strictly longer than it.
    over_sec: dict[str, int]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def word_duration_profile(
    words: Sequence[dict[str, Any]], *, thresholds: Sequence[float] = DURATION_THRESHOLDS_SEC
) -> DurationProfile:
    """Profile ``end - start`` across ``words`` (predicted or reference, either side)."""
    durations = sorted(word["end"] - word["start"] for word in words)
    n = len(durations)

    def _percentile(p: float) -> float | None:
        if not n:
            return None
        index = min(n - 1, max(0, ceil(p * n) - 1))
        return durations[index]

    return DurationProfile(
        words=n,
        max_sec=durations[-1] if n else None,
        p95_sec=_percentile(0.95),
        p99_sec=_percentile(0.99),
        over_sec={
            f"{threshold:.2f}": sum(1 for d in durations if d > threshold)
            for threshold in thresholds
        },
    )


def duration_errors_sec(
    pairs: Sequence[tuple[dict[str, Any], dict[str, Any]]],
) -> list[float]:
    """Absolute |predicted duration - reference duration| for each matched pair.

    Takes the output of :func:`matched_word_pairs` directly, so it only scores
    words both sides transcribed the same text for.
    """
    return [abs((pred["end"] - pred["start"]) - (ref["end"] - ref["start"])) for ref, pred in pairs]


def matched_word_pairs(
    reference: list[dict[str, Any]], prediction: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Return the validated, exact monotone word pairing used by the metric.

    This is also what the benchmark's ``agree`` view uses to rank per-word
    disagreements between two predictions.
    """
    _validate(reference, prediction)
    return _matched_pairs(reference, prediction)


def _validate(reference: list[dict[str, Any]], prediction: list[dict[str, Any]]) -> None:
    if len(reference) > MAX_BENCHMARK_WORDS or len(prediction) > MAX_BENCHMARK_WORDS:
        raise ValueError(
            f"word-boundary benchmark supports at most {MAX_BENCHMARK_WORDS} words per side"
        )
    for words in (reference, prediction):
        for word in words:
            if not isinstance(word.get("text"), str) or not _key(word["text"]):
                raise ValueError("every word needs nonempty text")
            start, end = word.get("start"), word.get("end")
            if (
                isinstance(start, bool)
                or isinstance(end, bool)
                or not isinstance(start, (int, float))
                or not isinstance(end, (int, float))
            ):
                raise ValueError("every word needs numeric start and end")
            if not (isfinite(start) and isfinite(end) and 0 <= start < end):
                raise ValueError("word boundaries must satisfy 0 <= start < end")


def _matched_pairs(
    reference: list[dict[str, Any]], prediction: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    n, m = len(reference), len(prediction)
    if not n or not m:
        return []
    ref_keys = [_key(word["text"]) for word in reference]
    pred_keys = [_key(word["text"]) for word in prediction]
    # A short-clip limit bounds this exact DP to 65,536 cells. One byte per
    # cell records the chosen predecessor: up, left, or matching diagonal.
    stride = m + 1
    back = bytearray((n + 1) * stride)
    previous = [(0, 0.0)] * stride
    for j in range(1, stride):
        back[j] = 2
    for i in range(n + 1):
        if i == 0:
            continue
        current = [(0, 0.0)] * stride
        back[i * stride] = 1
        for j in range(1, stride):
            options = [(previous[j], 1), (current[j - 1], 2)]
            if ref_keys[i - 1] == pred_keys[j - 1]:
                ref, pred = reference[i - 1], prediction[j - 1]
                cost = abs(ref["start"] - pred["start"]) + abs(ref["end"] - pred["end"])
                count, error = previous[j - 1]
                options.append(((count + 1, error + cost), 3))
            score, direction = max(options, key=lambda item: (item[0][0], -item[0][1]))
            current[j] = score
            back[i * stride + j] = direction
        previous = current

    matched: list[tuple[dict[str, Any], dict[str, Any]]] = []
    i, j = n, m
    while i or j:
        direction = back[i * stride + j]
        if direction == 3:
            matched.append((reference[i - 1], prediction[j - 1]))
            i -= 1
            j -= 1
        elif direction == 1:
            i -= 1
        else:
            j -= 1
    matched.reverse()
    return matched
