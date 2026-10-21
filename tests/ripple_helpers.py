"""Ripple-delete helpers for tests of cut geometry, not of the speech guard.

They exercise the private mechanical writers with synthetic geometry.
``tests/test_edit_modes.py`` and ``tests/test_source_remove_geometry.py`` cover
the public application policy and publication boundary.
"""

from __future__ import annotations

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.ripple import RippleRemoval, TrimEdge, plan_trim
from podcast_mcp.edits.timeline_ops import (
    _write_ripple_delete,
    _write_trim_clip_edge,
    plan_ripple_delete,
    plan_shorten_word_gaps,
)
from podcast_mcp.models import EditMode, EpisodeProject


def trim(
    project: EpisodeProject,
    clip_id: str,
    edge: TrimEdge,
    source_sec: float,
    mode: EditMode = EditMode.RIPPLE,
) -> dict:
    plan = plan_trim(project, clip_id, edge, source_sec, mode)
    if plan.unchanged:
        return {"operation": "trim_clip_edge", "unchanged": True}
    return _write_trim_clip_edge(project, plan, defaults=load_defaults())


def shorten_gaps(
    project: EpisodeProject,
    max_gap_sec: float = 0.35,
    *,
    use_inaudible_opt: bool | None = None,
) -> dict:
    removal = plan_shorten_word_gaps(
        project, max_gap_sec, use_inaudible_opt=use_inaudible_opt, defaults=load_defaults()
    )
    if removal is None:
        return {"operation": "shorten_word_gaps", "affected_tracks": []}
    report = _write_ripple_delete(
        project, removal, params={"use_inaudible_opt": use_inaudible_opt}, defaults=load_defaults()
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
                project, start, end, use_inaudible_opt=use_inaudible_opt, defaults=load_defaults()
            ).spans
        ]
    )
    return _write_ripple_delete(
        project,
        removal,
        record_log=record_log,
        params={"use_inaudible_opt": use_inaudible_opt},
        defaults=load_defaults(),
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
