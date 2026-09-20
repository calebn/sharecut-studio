"""Source-clock edit/word spans mapped onto the session timeline."""

from __future__ import annotations

from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.util.timebase import SourceSec


def map_source_span_fields(
    timeline: SessionTimeline,
    track_id: str,
    source_start: float,
    source_end: float,
) -> tuple[bool, list[dict[str, float]], float | None, float | None]:
    """Map a source-clock interval to timeline spans (first/last bounds)."""
    spans = timeline.map_source_span(
        track_id,
        SourceSec(source_start),
        SourceSec(source_end),
    )
    mappable = bool(spans)
    timeline_spans = [{"start": float(start), "end": float(end)} for start, end in spans]
    timeline_start = timeline_spans[0]["start"] if timeline_spans else None
    timeline_end = timeline_spans[-1]["end"] if timeline_spans else None
    return mappable, timeline_spans, timeline_start, timeline_end
