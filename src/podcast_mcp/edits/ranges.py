from __future__ import annotations

from collections.abc import Iterable

from podcast_mcp.util.intervals import merge_intervals as merge_intervals
from podcast_mcp.util.intervals import subtract_intervals

# Tolerance (seconds) for span edge comparisons: touching spans do not overlap.
SPAN_EPS_S = 1e-9


def merge_timeline_ranges(
    ranges: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    return merge_intervals(ranges, gap=1e-6)


def subtract_ranges_from_intervals(
    segments: list[tuple[float, float]],
    removes: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Return timeline intervals remaining after subtracting remove ranges."""
    return subtract_intervals(segments, removes, epsilon=SPAN_EPS_S)


def overlaps_remove_range(
    start: float,
    end: float,
    removes: list[tuple[float, float]],
) -> bool:
    for rs, re in removes:
        if end <= rs + SPAN_EPS_S or start >= re - SPAN_EPS_S:
            continue
        return True
    return False


def clamp_spans(
    spans: Iterable[tuple[float, float]], lo: float, hi: float
) -> list[tuple[float, float]]:
    """Overlap of each ``(start, end)`` span with ``[lo, hi]``; empty overlaps are dropped."""
    out: list[tuple[float, float]] = []
    for start, end in spans:
        s = max(float(start), float(lo))
        e = min(float(end), float(hi))
        if e > s + SPAN_EPS_S:
            out.append((s, e))
    return out
