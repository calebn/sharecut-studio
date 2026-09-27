"""Compare word timestamps with an independently timed reference transcript."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from math import isfinite
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
    boundary_mae_ms: float
    words_over_150ms: int
    words_over_150ms_fraction: float

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def measure_word_boundaries(
    reference: list[dict[str, Any]], prediction: list[dict[str, Any]]
) -> BoundaryMetrics:
    """Measure matching words only; count insertions/deletions separately.

    ``boundary_mae_ms`` averages the absolute start and end errors. A word is
    over 150 ms when either boundary is off by strictly more than 150 ms.
    Sequence matching keeps repeated words in order without pairing unrelated
    text solely because its timestamp happens to be nearby.
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

    matcher = SequenceMatcher(
        None,
        [_key(word["text"]) for word in reference],
        [_key(word["text"]) for word in prediction],
        autojunk=False,
    )
    pairs = [
        (reference[i], prediction[j])
        for block in matcher.get_matching_blocks()
        for i, j in zip(
            range(block.a, block.a + block.size),
            range(block.b, block.b + block.size),
            strict=True,
        )
    ]
    if not pairs:
        raise ValueError("reference and prediction have no matching words")
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
        boundary_mae_ms=1000 * sum(start + end for start, end in errors) / (2 * matched),
        words_over_150ms=over,
        words_over_150ms_fraction=over / matched,
    )
