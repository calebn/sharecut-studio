from __future__ import annotations


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
            if re <= s + 1e-9 or rs >= e - 1e-9:
                next_segments.append((s, e))
            else:
                if s < rs - 1e-9:
                    next_segments.append((s, min(rs, e)))
                if re < e - 1e-9:
                    next_segments.append((max(re, s), e))
        segments = next_segments
    return segments


def overlaps_remove_range(
    start: float,
    end: float,
    removes: list[tuple[float, float]],
) -> bool:
    for rs, re in removes:
        if end <= rs + 1e-9 or start >= re - 1e-9:
            continue
        return True
    return False
