"""The audio an insert-target session was staged at: capture it, then find it again at Accept."""

from __future__ import annotations

from typing import Literal

from podcast_mcp.edits.ripple import ripple_track_ids
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.ranges import SPAN_EPS_S
from podcast_mcp.engines.session_timeline import (
    clip_source_at_timeline,
    shift_at,
)
from podcast_mcp.models import Clip, EpisodeProject, InsertAnchor, SessionSuggestion
from podcast_mcp.util.coded_error import CodedValueError

_EPS = SPAN_EPS_S


def _dialogue_clips(project: EpisodeProject) -> list[Clip]:
    return [clip for tid in ripple_track_ids(project) for clip in clips_for_track(project, tid)]


def _clip_anchor(
    clip: Clip, at_sec: float, *, side: Literal["before", "after"], source_sec: float
) -> InsertAnchor:
    return InsertAnchor(
        kind="clip",
        at_sec=at_sec,
        track_id=clip.track_id,
        source_id=clip.source_id,
        source_sec=max(source_sec, 0.0),
        side=side,
        offset_s=at_sec - (source_sec + shift_at(clip, source_sec)),
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


def _range_anchor(
    clips: list[Clip], at_sec: float, track_ids: list[str], *, ending: bool
) -> InsertAnchor | None:
    containing = [c for c in clips if c.timeline_start - _EPS <= at_sec < c.timeline_end - _EPS]
    ends_here = [
        c
        for c in clips
        if abs(c.timeline_end - at_sec) <= _EPS and c.timeline_start + _EPS < at_sec
    ]
    options: list[tuple[Clip, Literal["before", "after"]]] = [
        *((c, "after") for c in ends_here if ending),
        *((c, "before") for c in containing),
    ]
    options.sort(key=lambda option: option[0].track_id not in track_ids)
    if not options:
        return None
    clip, side = options[0]
    source_sec = clip.source_end if side == "after" else clip_source_at_timeline(clip, at_sec)
    return InsertAnchor(
        kind="clip",
        at_sec=at_sec,
        track_id=clip.track_id,
        source_id=clip.source_id,
        source_sec=max(source_sec, 0.0),
        side=side,
        offset_s=0.0,
    )


def capture_range_anchors(
    project: EpisodeProject, from_sec: float, to_sec: float, track_ids: list[str]
) -> tuple[InsertAnchor | None, InsertAnchor | None]:
    """What each end of ``[from_sec, to_sec)`` is anchored to on the dialogue tracks now.

    A point inside a clip, or at a clip's start, is that clip's source second (and the end
    may also sit on a clip's end). Clips on ``track_ids`` are preferred. Neither anchor is
    ever an ``end`` anchor, and a point in a gap has none: both are ``None`` then.
    """
    clips = _dialogue_clips(project)
    start = _range_anchor(clips, from_sec, track_ids, ending=False)
    stop = _range_anchor(clips, to_sec, track_ids, ending=True)
    if start is None or stop is None:
        return None, None
    return start, stop


def _stale() -> CodedValueError:
    return CodedValueError(
        "The audio this session was staged at is no longer on the timeline, or more than one "
        "copy of it is. Record the session again at the new spot.",
        code="stale_anchor",
    )


def resolve_insert_anchor(project: EpisodeProject, anchor: InsertAnchor) -> float:
    """The timeline second ``anchor`` is at now; ``stale_anchor`` when its audio is gone or unclear.

    Several clips can hold the same source second (a copy, a paste, a duplicate). They agree
    only when they put the point at one spot, or when exactly one still puts it where it was
    recorded; otherwise the point is not guessed.
    """
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
        raise _stale()
    starts_here = [c for c in candidates if abs(c.source_start - source_sec) <= _EPS]
    ends_here = [c for c in candidates if abs(c.source_end - source_sec) <= _EPS]
    if starts_here and ends_here:
        dropped = ends_here if anchor.side == "before" else starts_here
        candidates = [c for c in candidates if c not in dropped] or candidates
    spots = [source_sec + shift_at(clip, source_sec) + anchor.offset_s for clip in candidates]
    if max(spots) - min(spots) > _EPS:
        recorded = [spot for spot in spots if abs(spot - anchor.at_sec) <= _EPS]
        if len(recorded) != 1:
            raise _stale()
        spots = recorded
    spot = spots[0]
    if abs(anchor.offset_s) > _EPS and any(
        tl_a + _EPS < spot < tl_a + (src_b - src_a) - _EPS
        for clip in _dialogue_clips(project)
        for src_a, src_b, tl_a in clip.virtual_pieces()
    ):
        raise _stale()
    return spot


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


def resolve_range(project: EpisodeProject, row: SessionSuggestion) -> tuple[float, float]:
    """The timeline range a replace session was staged over, found again from its anchors.

    ``stale_anchor`` when either end is gone or unclear, the range collapsed, or it no longer
    holds the same length of audio it did when staged (anything added or taken out inside).
    """
    anchor, end_anchor = row.anchor, row.end_anchor
    if anchor is None or end_anchor is None or "end" in (anchor.kind, end_anchor.kind):
        raise CodedValueError(
            "This session was not recorded over a range that starts and ends on speech, so the "
            "audio to replace cannot be found again. Record it again with both ends on audio.",
            code="stale_anchor",
        )
    start = resolve_insert_anchor(project, anchor)
    stop = resolve_insert_anchor(project, end_anchor)
    if start >= -_EPS and stop - start <= _EPS:
        raise CodedValueError(
            "The audio this session was recorded to replace has been cut away, so there is "
            "nothing left in that range to replace. Record the session again over audio that "
            "is still there.",
            code="stale_anchor",
        )
    if start < -_EPS:
        raise _stale()
    staged_length = end_anchor.at_sec - anchor.at_sec
    if abs((stop - start) - staged_length) > _EPS:
        raise CodedValueError(
            "The range this session was recorded to replace has changed since: audio was added "
            "to it or taken out of it. Record the session again over the range as it is now.",
            code="stale_anchor",
        )
    return max(start, 0.0), stop
