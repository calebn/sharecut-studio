"""Source-to-timeline bounds shared without importing the edits package."""

from __future__ import annotations

from typing import TYPE_CHECKING

from podcast_mcp.util.timebase import SourceSec

if TYPE_CHECKING:
    from podcast_mcp.engines.session_timeline import SessionTimeline


def source_span_timeline_bounds(
    timeline: SessionTimeline,
    track_id: str,
    source_start: float,
    source_end: float,
    *,
    default: tuple[float | None, float | None] = (None, None),
) -> tuple[float | None, float | None]:
    """First/last timeline bounds of a source span, with the caller's empty fallback."""
    spans = timeline.map_source_span(track_id, SourceSec(source_start), SourceSec(source_end))
    if not spans:
        return default
    return float(spans[0][0]), float(spans[-1][1])
