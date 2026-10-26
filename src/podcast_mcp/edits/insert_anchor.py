"""The audio an insert-target session was staged at: capture it, then find it again at Accept."""

from __future__ import annotations

from typing import Literal

from podcast_mcp.edits.ripple import ripple_track_ids
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.ranges import SPAN_EPS_S
from podcast_mcp.engines.session_timeline import (
    clip_source_at_timeline,
    clip_source_to_timeline_shift,
)
from podcast_mcp.models import Clip, EpisodeProject, InsertAnchor, SessionSuggestion
from podcast_mcp.util.coded_error import CodedValueError

_EPS = SPAN_EPS_S


def _dialogue_clips(project: EpisodeProject) -> list[Clip]:
    return [clip for tid in ripple_track_ids(project) for clip in clips_for_track(project, tid)]


def _clip_anchor(
    clip: Clip, at_sec: float, *, side: Literal["before", "after"], source_sec: float
) -> InsertAnchor:
    shift = clip_source_to_timeline_shift(clip)
    return InsertAnchor(
        kind="clip",
        at_sec=at_sec,
        track_id=clip.track_id,
        source_id=clip.source_id,
        source_sec=max(source_sec, 0.0),
        side=side,
        offset_s=at_sec - (source_sec + shift),
    )


def capture_insert_anchor(project: EpisodeProject, at_sec: float) -> InsertAnchor:
    """What ``at_sec`` is anchored to on the dialogue tracks now.

    Inside a clip, or at its start: that clip's source second. In a gap: the end of the
    previous clip plus the distance past it (or the next clip's start, minus the distance,
    before all audio). At or past the end of all dialogue: the end.
    """
    clips = _dialogue_clips(project)
    if not clips or at_sec >= max(clip.timeline_end for clip in clips) - _EPS:
        return InsertAnchor(kind="end", at_sec=at_sec)
    for clip in clips:
        if clip.timeline_start - _EPS <= at_sec < clip.timeline_end - _EPS:
            return _clip_anchor(
                clip, at_sec, side="before", source_sec=clip_source_at_timeline(clip, at_sec)
            )
    earlier = [clip for clip in clips if clip.timeline_end <= at_sec + _EPS]
    if earlier:
        last = max(earlier, key=lambda clip: clip.timeline_end)
        return _clip_anchor(last, at_sec, side="after", source_sec=last.source_end)
    first = min(clips, key=lambda clip: clip.timeline_start)
    return _clip_anchor(first, at_sec, side="before", source_sec=first.source_start)


def resolve_insert_anchor(project: EpisodeProject, anchor: InsertAnchor) -> float:
    """The timeline second ``anchor`` is at now; ``stale_anchor`` when its audio is gone."""
    if anchor.kind == "end" or anchor.track_id is None or anchor.source_sec is None:
        return max((clip.timeline_end for clip in _dialogue_clips(project)), default=0.0)
    source_sec = anchor.source_sec
    candidates = [
        clip
        for clip in clips_for_track(project, anchor.track_id)
        if clip.source_id == anchor.source_id
        and clip.source_start - _EPS <= source_sec <= clip.source_end + _EPS
    ]
    if not candidates:
        raise CodedValueError(
            "The audio this session was staged at is no longer on the timeline. "
            "Record the session again at the new spot.",
            code="stale_anchor",
        )
    clip = min(
        candidates,
        key=lambda c: abs(
            (c.source_start if anchor.side == "before" else c.source_end) - source_sec
        ),
    )
    return source_sec + clip_source_to_timeline_shift(clip) + anchor.offset_s


def insert_anchor_key(anchor: InsertAnchor) -> tuple[object, ...]:
    return (
        anchor.kind,
        anchor.track_id,
        anchor.source_id,
        None if anchor.source_sec is None else round(anchor.source_sec, 6),
        anchor.side,
        round(anchor.offset_s, 6),
    )


def pending_anchor_holder(
    project: EpisodeProject, anchor: InsertAnchor, session_id: str
) -> SessionSuggestion | None:
    """The other pending insert session staged at the same anchor, if any.

    Two sessions at one anchor have no order of their own, so the second is not staged.
    """
    key = insert_anchor_key(anchor)
    return next(
        (
            row
            for row in project.editorial.session_suggestions
            if row.kind == "insert"
            and row.status == "pending"
            and row.session_id != session_id
            and row.anchor is not None
            and insert_anchor_key(row.anchor) == key
        ),
        None,
    )
