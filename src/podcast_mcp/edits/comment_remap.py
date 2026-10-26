"""Remap timeline-anchored intervals after a ripple cut or an insert.

Used for review comments and chapter markers so absolute timeline times stay
aligned with what guests hear after material is removed or opened.
"""

from __future__ import annotations

from dataclasses import dataclass

from podcast_mcp.models import ChapterMarker, EditDecision, EpisodeProject, TimelineComment
from podcast_mcp.models.episode import RangeInterval

_EPS = 1e-9


@dataclass(frozen=True)
class RemappedInterval:
    """Result of remapping one [start, end] against a cut. None return = dropped."""

    start: float
    end: float | None


def remap_interval_for_cut(
    start: float,
    end: float | None,
    cut_start: float,
    cut_end: float,
) -> RemappedInterval | None:
    """Shift/clamp/drop an interval when ``[cut_start, cut_end)`` is removed.

    - Fully before the cut: unchanged
    - Fully inside the cut: dropped
    - Fully after the cut: subtract delta
    - Overlapping: clamp to surviving material; drop if zero-length
    """
    if cut_end <= cut_start:
        return RemappedInterval(start=start, end=end)

    delta = cut_end - cut_start
    if end is None:
        span_end = start
        if span_end <= cut_start + _EPS:
            return RemappedInterval(start=start, end=end)
        if start >= cut_end - _EPS:
            return RemappedInterval(start=start - delta, end=None)
        return None

    span_end = end
    if span_end <= cut_start + _EPS:
        return RemappedInterval(start=start, end=end)

    if start >= cut_end - _EPS:
        return RemappedInterval(start=start - delta, end=end - delta)

    if start >= cut_start - _EPS and span_end <= cut_end + _EPS:
        return None

    new_start = start if start < cut_start else cut_start
    new_end = cut_start if end <= cut_end else end - delta
    if new_end <= new_start + _EPS:
        return None
    return RemappedInterval(start=new_start, end=new_end)


def remap_comments_for_cut(
    comments: list[TimelineComment],
    cut_start: float,
    cut_end: float,
) -> list[TimelineComment]:
    out: list[TimelineComment] = []
    for c in comments:
        remapped = remap_interval_for_cut(c.timeline_start, c.timeline_end, cut_start, cut_end)
        if remapped is None:
            continue
        out.append(
            c.model_copy(
                update={
                    "timeline_start": remapped.start,
                    "timeline_end": remapped.end,
                }
            )
        )
    return out


def remap_chapters_for_cut(
    chapters: list[ChapterMarker],
    cut_start: float,
    cut_end: float,
) -> list[ChapterMarker]:
    out: list[ChapterMarker] = []
    for ch in chapters:
        remapped = remap_interval_for_cut(ch.time, None, cut_start, cut_end)
        if remapped is None:
            continue
        out.append(ch.model_copy(update={"time": remapped.start}))
    return out


def remap_review_anchors_for_cuts(
    project: EpisodeProject,
    cuts: list[tuple[float, float]],
) -> None:
    """Apply successive cut remaps to comments and chapters (mutates project).

    Cuts are absolute times on the pre-batch timeline. Apply right-to-left so
    each cut's coordinates remain valid after later (higher) cuts are applied.
    """
    if not cuts:
        return
    comments = list(project.review.comments)
    chapters = list(project.editorial.chapters)
    for cut_start, cut_end in sorted(cuts, key=lambda r: r[0], reverse=True):
        comments = remap_comments_for_cut(comments, cut_start, cut_end)
        chapters = remap_chapters_for_cut(chapters, cut_start, cut_end)
    project.review.comments = comments
    project.editorial.chapters = chapters


def _start_after_insert(start: float, at_time: float, duration_sec: float) -> float:
    return start + duration_sec if start >= at_time - _EPS else start


def _end_after_insert(start: float, end: float, at_time: float, duration_sec: float) -> float:
    moved = start >= at_time - _EPS or end > at_time + _EPS
    return end + duration_sec if moved else end


def shift_review_anchors_for_insert(
    project: EpisodeProject,
    at_time: float,
    duration_sec: float,
) -> None:
    """Move comments (with their spans) and chapters for a gap opened at ``at_time`` (mutates project).

    An interval starting at or after the point moves; one the point falls inside grows. Pending
    timeline-timebase edit decisions without an exact range move the same way; source-timebase
    ones follow their clips, exact ranges are re-checked at approval, and applied records stay.
    """
    project.editorial.edit_decisions = [
        _shifted_decision(edit, at_time, duration_sec) for edit in project.editorial.edit_decisions
    ]
    project.review.comments = [
        c.model_copy(
            update={
                "timeline_start": _start_after_insert(c.timeline_start, at_time, duration_sec),
                "timeline_end": (
                    None
                    if c.timeline_end is None
                    else _end_after_insert(c.timeline_start, c.timeline_end, at_time, duration_sec)
                ),
                "timeline_spans": [
                    RangeInterval(
                        start=_start_after_insert(span.start, at_time, duration_sec),
                        end=_end_after_insert(span.start, span.end, at_time, duration_sec),
                    )
                    for span in c.timeline_spans
                ],
            }
        )
        for c in project.review.comments
    ]
    project.editorial.chapters = [
        ch.model_copy(update={"time": _start_after_insert(ch.time, at_time, duration_sec)})
        for ch in project.editorial.chapters
    ]


def _shifted_decision(edit: EditDecision, at_time: float, duration_sec: float) -> EditDecision:
    if edit.applied or edit.timebase != "timeline" or edit.exact_range is not None:
        return edit
    return edit.model_copy(
        update={
            "start": _start_after_insert(edit.start, at_time, duration_sec),
            "end": _end_after_insert(edit.start, edit.end, at_time, duration_sec)
            if edit.end > edit.start
            else _start_after_insert(edit.end, at_time, duration_sec),
        }
    )
