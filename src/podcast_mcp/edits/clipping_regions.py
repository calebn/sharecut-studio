"""Encoder clipping spans on recorded sources (source-media seconds).

Recording sessions detect sample-peak clipping in the browser encoder and land
the spans on ``SourceRecording.clipping_regions``. ``list_clips`` reports the
part of each span a clip still shows, so flags follow cuts, trims and moves.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from podcast_mcp.edits.ranges import clamp_spans
from podcast_mcp.models import SourceClippingRegion, SourceRecording


def clipping_regions_from_ms(
    spans: Iterable[Iterable[int]] | None, duration_s: float | None
) -> list[SourceClippingRegion]:
    """Segment-relative ``[start_ms, end_ms]`` pairs as source spans clamped to the file."""
    limit = float(duration_s) if duration_s is not None else math.inf
    spans_s = (
        (start_ms / 1000.0, end_ms / 1000.0)
        for start_ms, end_ms in (list(span) for span in spans or [])
    )
    return [SourceClippingRegion(start_s=s, end_s=e) for s, e in clamp_spans(spans_s, 0.0, limit)]


def clip_clipping_payload(
    source: SourceRecording | None, source_start: float, source_end: float
) -> list[dict[str, float]]:
    """Sorted ``{start_s, end_s}`` dicts for the source spans inside a clip window."""
    if source is None:
        return []
    spans = clamp_spans(
        ((r.start_s, r.end_s) for r in source.clipping_regions), source_start, source_end
    )
    return [{"start_s": s, "end_s": e} for s, e in sorted(spans)]
