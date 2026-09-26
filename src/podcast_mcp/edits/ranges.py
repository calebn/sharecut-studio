from __future__ import annotations

from collections.abc import Iterable

# Tolerance (seconds) for span edge comparisons: touching spans do not overlap.
SPAN_EPS_S = 1e-9


def merge_timeline_ranges(
    ranges: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    if not ranges:
        return []
    sorted_ranges = sorted(ranges, key=lambda r: r[0])
    merged: list[tuple[float, float]] = [sorted_ranges[0]]
    for start, end in sorted_ranges[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end + 1e-6:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def subtract_ranges_from_intervals(
    segments: list[tuple[float, float]],
    removes: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Return timeline intervals remaining after subtracting remove ranges."""
    for rs, re in removes:
        if re <= rs:
            continue
        next_segments: list[tuple[float, float]] = []
        for s, e in segments:
            if re <= s + SPAN_EPS_S or rs >= e - SPAN_EPS_S:
                next_segments.append((s, e))
            else:
                if s < rs - SPAN_EPS_S:
                    next_segments.append((s, min(rs, e)))
                if re < e - SPAN_EPS_S:
                    next_segments.append((max(re, s), e))
        segments = next_segments
    return segments


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
