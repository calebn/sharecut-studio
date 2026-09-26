"""Encoder clipping spans on recorded sources (source-media seconds).

Recording sessions detect sample-peak clipping in the browser encoder and land
the spans on ``SourceRecording.clipping_regions``. ``list_clips`` reports the
part of each span a clip still shows, so flags follow cuts, trims and moves.
"""

from __future__ import annotations

from collections.abc import Iterable

from podcast_mcp.models import SourceClippingRegion, SourceRecording


def clipping_regions_from_ms(
    spans: Iterable[Iterable[int]] | None, duration_s: float | None
) -> list[SourceClippingRegion]:
    """Segment-relative ``[start_ms, end_ms]`` pairs as source spans clamped to the file."""
    out: list[SourceClippingRegion] = []
    limit = float(duration_s) if duration_s is not None else None
    for span in spans or []:
        start_ms, end_ms = list(span)
        start = max(0.0, start_ms / 1000.0)
        end = end_ms / 1000.0
        if limit is not None:
            end = min(end, limit)
        if end > start + 1e-9:
            out.append(SourceClippingRegion(start_s=start, end_s=end))
    return out


def clip_clipping_payload(
    source: SourceRecording | None, source_start: float, source_end: float
) -> list[dict[str, float]]:
    """Sorted ``{start_s, end_s}`` dicts for the source spans inside a clip window."""
    if source is None:
        return []
    rows: list[dict[str, float]] = []
    for region in source.clipping_regions:
        start = max(float(region.start_s), float(source_start))
        end = min(float(region.end_s), float(source_end))
        if end > start + 1e-9:
            rows.append({"start_s": start, "end_s": end})
    return sorted(rows, key=lambda row: (row["start_s"], row["end_s"]))
