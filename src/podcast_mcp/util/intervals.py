"""Numeric interval merging shared by timeline mapping and edit operations."""

from __future__ import annotations

from collections.abc import Iterable


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
