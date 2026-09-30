"""Numeric interval merging shared by timeline mapping and edit operations."""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class HalfOpenIntervalIndex:
    """Immutable overlap index for half-open spans, retaining input ordinals.

    Construction sorts once; existence queries are logarithmic and candidate
    queries visit only the relevant sorted-start suffix. Empty spans are ignored.
    """

    starts: tuple[float, ...]
    ends: tuple[float, ...]
    max_ends: tuple[float, ...]
    ordinals: tuple[int, ...]

    @classmethod
    def build(cls, spans: Iterable[tuple[float, float]]) -> HalfOpenIntervalIndex:
        ordered = sorted(
            (float(start), ordinal, float(end))
            for ordinal, (start, end) in enumerate(spans)
            if end > start
        )
        maximum = float("-inf")
        max_ends: list[float] = []
        for _start, _ordinal, end in ordered:
            maximum = max(maximum, end)
            max_ends.append(maximum)
        return cls(
            tuple(start for start, _ordinal, _end in ordered),
            tuple(end for _start, _ordinal, end in ordered),
            tuple(max_ends),
            tuple(ordinal for _start, ordinal, _end in ordered),
        )

    def overlaps(self, start: float, end: float) -> bool:
        if end <= start:
            return False
        upper = bisect_left(self.starts, end)
        return upper > 0 and self.max_ends[upper - 1] > start

    def overlapping_ordinals(self, start: float, end: float) -> tuple[int, ...]:
        if end <= start:
            return ()
        upper = bisect_left(self.starts, end)
        lower = bisect_right(self.max_ends, start, 0, upper)
        return tuple(self.ordinals[i] for i in range(lower, upper) if self.ends[i] > start)

    def start_rank(self, point: float) -> int:
        """Count of indexed spans starting at or before ``point``.

        ``ordinals[rank - 1]`` is the last span starting at or before ``point``
        and ``ordinals[rank]`` the first starting after it (ties by input order).
        """
        return bisect_right(self.starts, point)


def merge_intervals(
    intervals: Iterable[tuple[float, float]], *, gap: float = 0.0
) -> list[tuple[float, float]]:
    """Merge sorted or unsorted overlapping intervals within ``gap`` seconds."""
    ordered = sorted(intervals)
    merged: list[tuple[float, float]] = []
    for start, end in ordered:
        if merged and start <= merged[-1][1] + gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def intersect_intervals(
    a: Iterable[tuple[float, float]], b: Iterable[tuple[float, float]]
) -> list[tuple[float, float]]:
    """Overlap of two interval sets (each merged first); empty overlaps dropped."""
    left, right = merge_intervals(a), merge_intervals(b)
    out: list[tuple[float, float]] = []
    i = j = 0
    while i < len(left) and j < len(right):
        start, end = max(left[i][0], right[j][0]), min(left[i][1], right[j][1])
        if end > start:
            out.append((start, end))
        if left[i][1] < right[j][1]:
            i += 1
        else:
            j += 1
    return out


def subtract_intervals(
    segments: list[tuple[float, float]],
    removes: Iterable[tuple[float, float]],
    *,
    epsilon: float = 0.0,
) -> list[tuple[float, float]]:
    """Keep the interval difference, with the caller's boundary tolerance."""
    for remove_start, remove_end in removes:
        if remove_end <= remove_start:
            continue
        remaining = []
        for start, end in segments:
            if remove_end <= start + epsilon or remove_start >= end - epsilon:
                remaining.append((start, end))
            else:
                if start < remove_start - epsilon:
                    remaining.append((start, min(remove_start, end)))
                if remove_end < end - epsilon:
                    remaining.append((max(remove_end, start), end))
        segments = remaining
    return segments
