"""Ripple-delete helpers for tests of cut geometry, not of the speech guard.

They plan the removal and pass it to ``ripple_delete`` already cleared, as a
person who confirmed "Cut anyway" would; ``tests/test_edit_modes.py`` covers
the guard itself.
"""

from __future__ import annotations

from podcast_mcp.edits.cut_speech import SpeechClearance
from podcast_mcp.edits.ripple import RippleRemoval, TrimEdge, plan_trim
from podcast_mcp.edits.timeline_ops import (
    plan_ripple_delete,
    plan_shorten_word_gaps,
    ripple_delete,
    trim_clip_edge,
)
from podcast_mcp.models import EditMode, EpisodeProject


def trim(
    project: EpisodeProject,
    clip_id: str,
    edge: TrimEdge,
    source_sec: float,
    mode: EditMode = EditMode.RIPPLE,
) -> dict:
    """Move one clip edge in ``mode``, as a confirmed edit."""
    plan = plan_trim(project, clip_id, edge, source_sec, mode)
    if plan.unchanged:
        return {"operation": "trim_clip_edge", "unchanged": True}
    return trim_clip_edge(project, plan, SpeechClearance(plan.removal))


def shorten_gaps(
    project: EpisodeProject,
    max_gap_sec: float = 0.35,
    *,
    use_inaudible_opt: bool | None = None,
) -> dict:
    """Ripple out each pause longer than ``max_gap_sec``, as a confirmed edit."""
    removal = plan_shorten_word_gaps(project, max_gap_sec, use_inaudible_opt=use_inaudible_opt)
    if removal is None:
        return {"operation": "shorten_word_gaps", "affected_tracks": []}
    report = ripple_delete(
        project, SpeechClearance(removal), params={"use_inaudible_opt": use_inaudible_opt}
    )
    return {**report, "operation": "shorten_word_gaps"}


def ripple_cut_spans(
    project: EpisodeProject,
    ranges: list[tuple[float, float]],
    *,
    use_inaudible_opt: bool | None = None,
    record_log: bool = True,
) -> dict:
    """Ripple-remove timeline ``ranges`` on every dialogue track in one removal."""
    removal = RippleRemoval.of(
        unselected=[
            span
            for start, end in ranges
            for span in plan_ripple_delete(
                project, start, end, use_inaudible_opt=use_inaudible_opt
            ).spans
        ]
    )
    return ripple_delete(
        project,
        SpeechClearance(removal),
        record_log=record_log,
        params={"use_inaudible_opt": use_inaudible_opt},
    )


def ripple_cut(
    project: EpisodeProject,
    start: float,
    end: float,
    *,
    use_inaudible_opt: bool | None = None,
    record_log: bool = True,
) -> dict:
    """Ripple-remove ``[start, end)`` on every dialogue track."""
    return ripple_cut_spans(
        project, [(start, end)], use_inaudible_opt=use_inaudible_opt, record_log=record_log
    )
