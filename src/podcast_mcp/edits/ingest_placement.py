"""Whole-file clip geometry for consolidated ingest sources (session-clock placement)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from podcast_mcp.edits.conversation_align import offset_to_clip_geometry

_EPS = 1e-9


@dataclass(frozen=True)
class SourceGeometry:
    source_start: float
    source_end: float
    timeline_start: float


@dataclass
class IngestPlacement:
    geometry: list[SourceGeometry]
    warnings: list[str] = field(default_factory=list)


def place_ingest_sources(
    speaker: str,
    durations: Sequence[float],
    *,
    placement_sec: float | None,
) -> IngestPlacement:
    """Clip geometry for one speaker's whole-file sources, in manifest order.

    ``placement_sec`` is ``content_align - session_start`` (``None`` for trimmed
    extracts, which are not re-placed). The primary source is placed with
    ``offset_to_clip_geometry`` so session t=0 lands on timeline 0; extra sources
    chain after it with no session offset of their own. A lead-in that would
    consume the whole primary file skips placement and returns a warning.
    """
    geometry: list[SourceGeometry] = []
    warnings: list[str] = []
    timeline_at = 0.0
    for idx, dur in enumerate(durations):
        src_start, tl_start = 0.0, timeline_at
        if idx == 0 and placement_sec is not None and dur > 0:
            if -placement_sec >= dur:
                warnings.append(
                    f"{speaker}: session placement {placement_sec:+.2f}s trims past the end "
                    f"of the {dur:.2f}s primary file; clip left unplaced at timeline 0"
                )
            else:
                src_start, _end, tl_start = offset_to_clip_geometry(
                    placement_sec, media_duration=dur
                )
        geometry.append(SourceGeometry(src_start, dur, tl_start))
        timeline_at = tl_start + max(0.0, dur - src_start)
    if len(durations) > 1 and placement_sec is not None and abs(placement_sec) > _EPS:
        warnings.append(
            f"{speaker}: {len(durations) - 1} extra source(s) chained after the placed "
            "primary clip without their own session offset; check their alignment"
        )
    return IngestPlacement(geometry=geometry, warnings=warnings)
