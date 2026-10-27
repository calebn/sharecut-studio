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


def start_after_insert(start: float, at_time: float, duration_sec: float) -> float:
    return start + duration_sec if start >= at_time - _EPS else start


def end_after_insert(start: float, end: float, at_time: float, duration_sec: float) -> float:
    moved = start >= at_time - _EPS or end > at_time + _EPS
    return end + duration_sec if moved else end


def shift_review_anchors_for_insert(
    project: EpisodeProject,
    at_time: float,
    duration_sec: float,
) -> None:
    """Move comments (with their spans) and chapters for a gap opened at ``at_time`` (mutates project).

    An interval starting at or after the point moves; one the point falls inside grows.
    """
    project.review.comments = [
        c.model_copy(
            update={
                "timeline_start": start_after_insert(c.timeline_start, at_time, duration_sec),
                "timeline_end": (
                    None
                    if c.timeline_end is None
                    else end_after_insert(c.timeline_start, c.timeline_end, at_time, duration_sec)
                ),
                "timeline_spans": [
                    RangeInterval(
                        start=start_after_insert(span.start, at_time, duration_sec),
                        end=end_after_insert(span.start, span.end, at_time, duration_sec),
                    )
                    for span in c.timeline_spans
                ],
            }
        )
        for c in project.review.comments
    ]
    project.editorial.chapters = [
        ch.model_copy(update={"time": start_after_insert(ch.time, at_time, duration_sec)})
        for ch in project.editorial.chapters
    ]


def shift_pending_decisions_for_insert(
    project: EpisodeProject,
    at_time: float,
    duration_sec: float,
    track_ids: set[str],
) -> None:
    """Move pending timeline-timebase edit decisions for a gap opened on ``track_ids`` (mutates project).

    Only decisions whose tracks are all among them move; an interval starting at or
    after the point moves and one the point falls inside grows. Source-timebase decisions
    follow their clips, exact ranges are re-checked at approval, and applied records stay.
    """
    project.editorial.edit_decisions = [
        _shifted_decision(edit, at_time, duration_sec)
        if set(edit.track_ids or [edit.track_id]) <= track_ids
        else edit
        for edit in project.editorial.edit_decisions
    ]


def _shifted_decision(edit: EditDecision, at_time: float, duration_sec: float) -> EditDecision:
    if edit.applied or edit.timebase != "timeline" or edit.exact_range is not None:
        return edit
    return edit.model_copy(
        update={
            "start": start_after_insert(edit.start, at_time, duration_sec),
            "end": end_after_insert(edit.start, edit.end, at_time, duration_sec)
            if edit.end > edit.start
            else start_after_insert(edit.end, at_time, duration_sec),
        }
    )


def remap_interval_for_replace(
    start: float,
    end: float | None,
    from_sec: float,
    to_sec: float,
    new_length: float,
) -> RemappedInterval:
    """Where an interval goes when ``[from_sec, to_sec)`` is replaced by ``new_length`` of audio.

    Nothing is dropped. At or before ``from_sec`` stays; at or after ``to_sec`` moves by the
    length difference. Inside, a point goes to ``from_sec`` and an interval that covers the
    whole range becomes the new audio's span. An interval that starts before the range and
    ends inside it ends at ``from_sec``; one that starts inside and ends after starts where
    the new audio ends.
    """
    delta = new_length - (to_sec - from_sec)
    if end is None or end <= start:
        if start <= from_sec + _EPS:
            return RemappedInterval(start=start, end=end)
        if start >= to_sec - _EPS:
            return RemappedInterval(start=start + delta, end=end)
        return RemappedInterval(start=from_sec, end=end)
    if end <= from_sec + _EPS:
        return RemappedInterval(start=start, end=end)
    if start >= to_sec - _EPS:
        return RemappedInterval(start=start + delta, end=end + delta)
    if start < from_sec - _EPS:
        return RemappedInterval(start=start, end=end + delta if end >= to_sec - _EPS else from_sec)
    if end >= to_sec - _EPS:
        if start <= from_sec + _EPS:
            return RemappedInterval(start=from_sec, end=end + delta)
        if end <= to_sec + _EPS:
            return RemappedInterval(start=from_sec, end=from_sec + new_length)
        return RemappedInterval(start=from_sec + new_length, end=end + delta)
    return RemappedInterval(start=from_sec, end=None)


def remap_review_anchors_for_replace(
    project: EpisodeProject,
    from_sec: float,
    to_sec: float,
    new_length: float,
) -> list[str]:
    """Move comments (with their spans) and chapters for a replaced range (mutates project).

    Every item is kept. Returns the ids of comments that started inside the range and were
    moved to its start.
    """
    clamped: list[str] = []
    comments: list[TimelineComment] = []
    for comment in project.review.comments:
        moved = remap_interval_for_replace(
            comment.timeline_start, comment.timeline_end, from_sec, to_sec, new_length
        )
        if from_sec + _EPS < comment.timeline_start < to_sec - _EPS:
            clamped.append(comment.id)
        spans: list[RangeInterval] = []
        for span in comment.timeline_spans:
            span_moved = remap_interval_for_replace(
                span.start, span.end, from_sec, to_sec, new_length
            )
            if span_moved.end is not None and span_moved.end > span_moved.start + _EPS:
                spans.append(RangeInterval(start=span_moved.start, end=span_moved.end))
        comments.append(
            comment.model_copy(
                update={
                    "timeline_start": moved.start,
                    "timeline_end": moved.end,
                    "timeline_spans": spans,
                }
            )
        )
    project.review.comments = comments
    project.editorial.chapters = [
        chapter.model_copy(
            update={
                "time": remap_interval_for_replace(
                    chapter.time, None, from_sec, to_sec, new_length
                ).start
            }
        )
        for chapter in project.editorial.chapters
    ]
    return clamped


def _movable_decision(edit: EditDecision, track_ids: set[str]) -> bool:
    return (
        not edit.applied
        and edit.timebase == "timeline"
        and edit.exact_range is None
        and set(edit.track_ids or [edit.track_id]) <= track_ids
    )


def pending_decisions_in_range(
    project: EpisodeProject, from_sec: float, to_sec: float, track_ids: set[str]
) -> list[str]:
    """Ids of pending timeline decisions on ``track_ids`` that overlap the inside of the range."""
    found: list[str] = []
    for edit in project.editorial.edit_decisions:
        if not _movable_decision(edit, track_ids):
            continue
        if edit.end > edit.start:
            overlaps = edit.start < to_sec - _EPS and edit.end > from_sec + _EPS
        else:
            overlaps = from_sec + _EPS < edit.start < to_sec - _EPS
        if overlaps:
            found.append(edit.id)
    return found


def shift_pending_decisions_for_replace(
    project: EpisodeProject, to_sec: float, delta: float, track_ids: set[str]
) -> None:
    """Move pending timeline decisions on ``track_ids`` that start at or after ``to_sec`` by ``delta``."""
    project.editorial.edit_decisions = [
        edit.model_copy(update={"start": edit.start + delta, "end": edit.end + delta})
        if _movable_decision(edit, track_ids) and edit.start >= to_sec - _EPS
        else edit
        for edit in project.editorial.edit_decisions
    ]
