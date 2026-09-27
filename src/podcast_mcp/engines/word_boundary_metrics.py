"""Compare word timestamps with an independently timed reference transcript."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from math import ceil, isfinite
from typing import Any


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
    Banded monotone sequence matching first maximizes matched text and then
    minimizes total boundary error. This resolves repeated-word ambiguity
    without comparing every word with every other word in long transcripts.
    """
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
    # The diagonal follows the relative transcript lengths. The bounded band
    # permits local insertions/deletions while keeping the cost linear in the
    # length of ordinary episode transcripts.
    band = 64 + ceil(max(n / m, m / n))
    previous: dict[int, tuple[int, float]] = {}
    back: dict[tuple[int, int], tuple[int, int, bool]] = {}
    for i in range(n + 1):
        center = round(i * m / n)
        current: dict[int, tuple[int, float]] = {}
        for j in range(max(0, center - band), min(m, center + band) + 1):
            if i == j == 0:
                current[j] = (0, 0.0)
                continue
            options: list[tuple[tuple[int, float], tuple[int, int, bool]]] = []
            if i and j in previous:
                options.append((previous[j], (i - 1, j, False)))
            if j and j - 1 in current:
                options.append((current[j - 1], (i, j - 1, False)))
            if i and j and ref_keys[i - 1] == pred_keys[j - 1] and j - 1 in previous:
                ref, pred = reference[i - 1], prediction[j - 1]
                cost = abs(ref["start"] - pred["start"]) + abs(ref["end"] - pred["end"])
                count, error = previous[j - 1]
                options.append(((count + 1, error + cost), (i - 1, j - 1, True)))
            if options:
                score, predecessor = max(options, key=lambda item: (item[0][0], -item[0][1]))
                current[j] = score
                back[i, j] = predecessor
        previous = current

    if m not in previous:
        raise ValueError("word sequences exceed the supported alignment band")
    matched: list[tuple[dict[str, Any], dict[str, Any]]] = []
    i, j = n, m
    while i or j:
        parent_i, parent_j, is_match = back[i, j]
        if is_match:
            matched.append((reference[i - 1], prediction[j - 1]))
        i, j = parent_i, parent_j
    matched.reverse()
    return matched
