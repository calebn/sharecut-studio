"""Compare word timestamps with an independently timed reference transcript."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from math import isfinite
from typing import Any

MAX_BENCHMARK_WORDS = 256


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

    pairs = _matched_pairs(reference, prediction)
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
        words_over_150ms=over,
        words_over_150ms_fraction=over / matched if matched else None,
    )


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
