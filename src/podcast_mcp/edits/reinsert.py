"""Inverse of a ripple cut: capture at apply time, locate the seam and put the material back.

A cut is found again by the **source clocks** of the clips that now meet at its seam, never by
timeline time, so later ripples that move the seam do not matter. The seam pair must still
meet exactly: the left clip ends at ``pre``, the right one starts at ``post`` and they are
adjacent, apart from the one replace-gap pad the cut may have inserted. Anything else is a
typed conflict, naming the applied edit that removed the audio when one did.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.comment_remap import remap_interval_for_cut, shift_review_anchors_for_insert
from podcast_mcp.edits.ripple import ripple_insert_clips, ripple_track_ids
from podcast_mcp.engines.clips_ops import (
    clips_for_track,
    new_clip_id,
    place_clips_at,
    remove_timeline_range_from_clips,
    set_track_clips,
    slice_timeline_range_from_clips,
    update_timeline_duration,
)
from podcast_mcp.engines.transcript_sync import restore_archived_words
from podcast_mcp.models import (
    AnchorBefore,
    AppliedEditRecord,
    ChapterMarker,
    Clip,
    ClipJoinMode,
    EdgeFade,
    EpisodeProject,
    ReinsertClips,
    ReinsertPad,
    SourceEdge,
    TimelineComment,
    TrackSeam,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import dialogue_track_ids

_TL_EPS = 1e-4
_SRC_EPS = 1e-6
_ANCHOR_EPS = 1e-6


@dataclass(frozen=True)
class SeamConflict:
    code: str
    message: str
    track_id: str | None = None
    blocked_by: tuple[str, ...] = ()


@dataclass(frozen=True)
class PadEdges:
    """What a replace-gap pad left: its record and the fades of the clips at its two edges."""

    pad: ReinsertPad
    edges: list[EdgeFade] = field(default_factory=list)


def edge_fade(clip: Clip, side: str) -> EdgeFade:
    """The fade state of ``clip``'s ``side`` edge (``"out"`` end, ``"in"`` start)."""
    if side == "out":
        return EdgeFade(
            track_id=clip.track_id,
            side="out",
            source_id=clip.source_id,
            source_sec=clip.source_end,
            fade_ms=clip.fade_out_ms,
        )
    return EdgeFade(
        track_id=clip.track_id,
        side="in",
        source_id=clip.source_id,
        source_sec=clip.source_start,
        fade_ms=clip.fade_in_ms,
        join_in_mode=clip.join_in_mode,
    )


def _seam_neighbours(clips: Sequence[Clip], at: float) -> tuple[Clip | None, Clip | None]:
    left = next((c for c in reversed(clips) if abs(c.timeline_end - at) <= _TL_EPS), None)
    right = next((c for c in clips if abs(c.timeline_start - at) <= _TL_EPS), None)
    return left, right


def capture_seams(
    before: Mapping[str, list[Clip]],
    project: EpisodeProject,
    start: float,
    end: float,
    *,
    defaults: EffectiveConfig,
) -> tuple[list[TrackSeam], list[EdgeFade]]:
    """Per track: the material ``[start, end)`` held, and the clips that meet at the seam now.

    ``project`` is read after the ripple. A track with neither material nor seam clips is left out.
    The returned edges are the seam clips' fades before any pad or join-fade writer touches them.
    """
    seams: list[TrackSeam] = []
    edges: list[EdgeFade] = []
    for tid, clips in before.items():
        removed = slice_timeline_range_from_clips(clips, start, end, defaults=defaults)
        left, right = _seam_neighbours(clips_for_track(project, tid), start)
        if not removed and left is None and right is None:
            continue
        seams.append(
            TrackSeam(
                track_id=tid,
                pre=SourceEdge(source_id=left.source_id, sec=left.source_end) if left else None,
                post=SourceEdge(source_id=right.source_id, sec=right.source_start)
                if right
                else None,
                removed=removed,
            )
        )
        if left is not None:
            edges.append(edge_fade(left, "out"))
        if right is not None:
            edges.append(edge_fade(right, "in"))
    return seams, edges


def capture_anchors(
    comments: Sequence[TimelineComment],
    chapters: Sequence[ChapterMarker],
    start: float,
    end: float,
) -> list[AnchorBefore]:
    """Comments and chapters that touch ``[start, end]``: the cut dropped, clamped or left them at the seam."""
    out: list[AnchorBefore] = []
    for index, comment in enumerate(comments):
        s, e = comment.timeline_start, comment.timeline_end
        if (e if e is not None else s) < start - _ANCHOR_EPS or s > end + _ANCHOR_EPS:
            continue
        moved = remap_interval_for_cut(s, e, start, end)
        out.append(
            AnchorBefore(
                kind="comment",
                id=comment.id,
                index=index,
                start=s - start,
                end=None if e is None else e - start,
                post_start=None if moved is None else moved.start - start,
                post_end=None if moved is None or moved.end is None else moved.end - start,
                comment=_rebased(comment, start) if moved is None else None,
            )
        )
    for index, chapter in enumerate(chapters):
        if not start - _ANCHOR_EPS <= chapter.time <= end + _ANCHOR_EPS:
            continue
        moved = remap_interval_for_cut(chapter.time, None, start, end)
        out.append(
            AnchorBefore(
                kind="chapter",
                index=index,
                start=chapter.time - start,
                post_start=None if moved is None else moved.start - start,
                chapter=chapter.model_copy(update={"time": chapter.time - start}),
            )
        )
    return out


def _rebased(comment: TimelineComment, start: float) -> TimelineComment:
    return comment.model_copy(
        update={
            "timeline_start": comment.timeline_start - start,
            "timeline_end": None if comment.timeline_end is None else comment.timeline_end - start,
        }
    )


def pad_record(
    *,
    sec: float,
    offset_from_seam: float,
    room_tone_clip_ids: Sequence[str],
) -> ReinsertPad:
    return ReinsertPad(
        kind="room_tone" if room_tone_clip_ids else "silence",
        sec=sec,
        clip_ids=list(room_tone_clip_ids),
        offset_from_seam=offset_from_seam,
    )


def _find(
    clips: Sequence[Clip], edge: SourceEdge, attr: str, *, skip: Collection[str] = ()
) -> Clip | None:
    """The clip whose ``attr`` clock is ``edge``; ``skip`` leaves out the cut's own pad fill.

    A room-tone fill shares its source clock with a neighbouring cut's fill, so the pad this
    cut inserted must not stand in for the clip it sits next to.
    """
    return next(
        (
            c
            for c in clips
            if c.id not in skip
            and c.source_id == edge.source_id
            and abs(getattr(c, attr) - edge.sec) <= _SRC_EPS
        ),
        None,
    )


def _blockers(
    log: Sequence[AppliedEditRecord], record_id: str, track_id: str, edge: SourceEdge
) -> tuple[str, ...]:
    """Applied edits whose removed material holds ``edge``: restoring them brings the edge back."""
    found: list[str] = []
    for other in log:
        inverse = other.inverse
        if other.id == record_id or not isinstance(inverse, ReinsertClips):
            continue
        if any(
            seam.track_id == track_id
            and any(
                piece.source_id == edge.source_id
                and piece.source_start - _SRC_EPS <= edge.sec <= piece.source_end + _SRC_EPS
                for piece in seam.removed
            )
            for seam in inverse.tracks
        ):
            found.append(other.id)
    return tuple(found)


@dataclass(frozen=True)
class SeamLocation:
    """Where a cut's seam is now, on the clock before any pad it inserted."""

    time: float
    ripple_tracks: tuple[str, ...]


def _pad_shifts(pad: ReinsertPad | None) -> tuple[float, float]:
    """How far the pad moved the left and right seam clips: both when it sits left of the seam."""
    if pad is None:
        return 0.0, 0.0
    offset = pad.offset_from_seam
    return (pad.sec if offset < -1e-9 else 0.0), (pad.sec if offset <= 1e-9 else 0.0)


def locate_seam(
    project: EpisodeProject, record: AppliedEditRecord, inverse: ReinsertClips
) -> SeamLocation | SeamConflict:
    padded = set(dialogue_track_ids(project))
    pad_ids = set(inverse.pad.clip_ids) if inverse.pad is not None else set()
    times: list[float] = []
    for seam in inverse.tracks:
        if project.track_by_id(seam.track_id) is None:
            return SeamConflict(
                "track_missing",
                f"Track {seam.track_id} is no longer in the project.",
                seam.track_id,
            )
        # The pad is inserted on dialogue tracks only; an edited track beside them stays put.
        shift_left, shift_right = _pad_shifts(inverse.pad if seam.track_id in padded else None)
        clips = clips_for_track(project, seam.track_id)
        left = right = None
        for edge, attr, name in (
            (seam.pre, "source_end", "left"),
            (seam.post, "source_start", "right"),
        ):
            if edge is None:
                continue
            clip = _find(clips, edge, attr, skip=pad_ids)
            if clip is None:
                blockers = _blockers(project.editorial.edit_log, record.id, seam.track_id, edge)
                return SeamConflict(
                    "seam_gone",
                    (
                        f"Later edits changed the audio next to this cut on {seam.track_id}. "
                        + (
                            f"Restore {', '.join(blockers)} first."
                            if blockers
                            else "Use History Undo."
                        )
                    ),
                    seam.track_id,
                    blockers,
                )
            if name == "left":
                left = clip
            else:
                right = clip
        if left is not None and right is not None:
            gap = right.timeline_start - left.timeline_end
            if abs(gap - (shift_right - shift_left)) > _TL_EPS:
                return SeamConflict(
                    "seam_not_adjacent",
                    f"Something was placed between the two sides of this cut on {seam.track_id}.",
                    seam.track_id,
                )
        if left is not None:
            times.append(left.timeline_end - shift_left)
        elif right is not None:
            times.append(right.timeline_start - shift_right)
    if not times:
        return SeamConflict("seam_not_found", "This cut has no clip left to anchor it on.")
    if max(times) - min(times) > _TL_EPS:
        return SeamConflict(
            "seam_misaligned", "The tracks no longer meet at one point for this cut."
        )
    ripple = tuple(ripple_track_ids(project, record.track_ids))
    pad_conflict = _check_pad(project, inverse, times[0], [t for t in ripple if t in padded])
    if pad_conflict is not None:
        return pad_conflict
    return SeamLocation(times[0], ripple)


def _check_pad(
    project: EpisodeProject, inverse: ReinsertClips, seam_time: float, ripple: Sequence[str]
) -> SeamConflict | None:
    pad = inverse.pad
    if pad is None:
        return None
    start = seam_time + pad.offset_from_seam
    end = start + pad.sec
    found: set[str] = set()
    for tid in ripple:
        for clip in clips_for_track(project, tid):
            overlap = min(clip.timeline_end, end) - max(clip.timeline_start, start)
            if overlap <= _TL_EPS:
                continue
            inside = clip.timeline_start >= start - _TL_EPS and clip.timeline_end <= end + _TL_EPS
            if clip.id not in pad.clip_ids or not inside:
                return SeamConflict(
                    "pad_changed", "The gap this cut left was edited. Use History Undo.", tid
                )
            found.add(clip.id)
    if found != set(pad.clip_ids):
        return SeamConflict("pad_changed", "The gap this cut left was edited. Use History Undo.")
    return None


def apply_reinsert(
    project: EpisodeProject,
    record: AppliedEditRecord,
    inverse: ReinsertClips,
    *,
    defaults: EffectiveConfig,
) -> None:
    located = locate_seam(project, record, inverse)
    if isinstance(located, SeamConflict):
        raise CodedValueError(located.message, code=located.code)
    at, ripple = located.time, located.ripple_tracks
    if inverse.pad is not None:
        pad_start = at + inverse.pad.offset_from_seam
        padded = set(dialogue_track_ids(project))
        for tid in (t for t in ripple if t in padded):
            set_track_clips(
                project,
                tid,
                remove_timeline_range_from_clips(
                    clips_for_track(project, tid),
                    pad_start,
                    pad_start + inverse.pad.sec,
                    defaults=defaults,
                ),
            )
    ripple_insert_clips(project, at, inverse.duration_sec, ripple, defaults=defaults)
    used = {c.id for c in project.clips}
    for seam in inverse.tracks:
        pieces = []
        for piece in seam.removed:
            fresh = piece.id in used
            pieces.append(
                piece.model_copy(deep=True, update={"id": new_clip_id()}) if fresh else piece
            )
            used.add(pieces[-1].id)
        set_track_clips(
            project,
            seam.track_id,
            place_clips_at(clips_for_track(project, seam.track_id), pieces, at),
        )
    _restore_fades(project, inverse.edges, at, inverse.duration_sec)
    restore_archived_words(
        project, {*record.track_ids, *(seam.track_id for seam in inverse.tracks)}
    )
    _restore_anchors(project, inverse, at)
    update_timeline_duration(project)


def _restore_fades(
    project: EpisodeProject, edges: Sequence[EdgeFade], at: float, duration: float
) -> None:
    """Put back each seam clip's fade; a clip sharing the source clock is told apart by position."""
    for edge in edges:
        out = edge.side == "out"
        candidates = [
            c
            for c in clips_for_track(project, edge.track_id)
            if c.source_id == edge.source_id
            and abs((c.source_end if out else c.source_start) - edge.source_sec) <= _SRC_EPS
        ]
        clip = min(
            candidates,
            key=lambda c: (
                abs(c.timeline_end - at) if out else abs(c.timeline_start - at - duration)
            ),
            default=None,
        )
        if clip is None:
            continue
        if edge.side == "out":
            clip.fade_out_ms = edge.fade_ms
        else:
            clip.fade_in_ms = edge.fade_ms
            clip.join_in_mode = edge.join_in_mode or ClipJoinMode.FADE


def _restore_anchors(project: EpisodeProject, inverse: ReinsertClips, at: float) -> None:
    """Move anchors across the reopened span and return the ones the cut dropped or clamped.

    An anchor the cut moved is put back only while it still sits where the cut left it, so a
    later hand edit stays. A comment's two ends are judged separately: a cut applied later may
    have moved one of them, and the other still goes home.
    """
    review, editorial = project.review, project.editorial
    moved_comments: list[tuple[AnchorBefore, int, bool, bool]] = []
    moved_chapters: list[tuple[AnchorBefore, int]] = []
    claimed: set[int] = set()
    comment_index = {c.id: i for i, c in enumerate(review.comments)}
    for anchor in inverse.anchors:
        if anchor.post_start is None:
            continue
        if anchor.kind == "comment":
            i = comment_index.get(anchor.id or "")
            if i is None:
                continue
            comment = review.comments[i]
            # Each end is judged alone: a later cut may have moved the other one.
            start_here = abs(comment.timeline_start - (at + anchor.post_start)) <= _ANCHOR_EPS
            end_here = (
                comment.timeline_end is None
                if anchor.post_end is None
                else comment.timeline_end is not None
                and abs(comment.timeline_end - (at + anchor.post_end)) <= _ANCHOR_EPS
            )
            if start_here or end_here:
                moved_comments.append((anchor, i, start_here, end_here))
            continue
        chapter = anchor.chapter
        assert chapter is not None
        i = next(
            (
                n
                for n, ch in enumerate(editorial.chapters)
                if n not in claimed
                and ch.title == chapter.title
                and ch.image_url == chapter.image_url
                and abs(ch.time - (at + anchor.post_start)) <= _ANCHOR_EPS
            ),
            None,
        )
        if i is not None:
            claimed.add(i)
            moved_chapters.append((anchor, i))
    spans = {c.id: c.timeline_spans for c in review.comments}
    shift_review_anchors_for_insert(project, at, inverse.duration_sec)
    for comment in review.comments:
        comment.timeline_spans = spans[comment.id]
    for anchor, i, start_here, end_here in moved_comments:
        update: dict[str, float | None] = {}
        if start_here:
            update["timeline_start"] = at + anchor.start
        if end_here:
            update["timeline_end"] = None if anchor.end is None else at + anchor.end
        review.comments[i] = review.comments[i].model_copy(update=update)
    for anchor, i in moved_chapters:
        editorial.chapters[i] = editorial.chapters[i].model_copy(update={"time": at + anchor.start})
    for anchor in sorted(
        (a for a in inverse.anchors if a.post_start is None), key=lambda a: a.index
    ):
        if anchor.kind == "chapter":
            chapter = anchor.chapter
            assert chapter is not None
            editorial.chapters.insert(
                min(anchor.index, len(editorial.chapters)),
                chapter.model_copy(update={"time": at + chapter.time}),
            )
        elif anchor.comment is not None and anchor.comment.id not in comment_index:
            comment = anchor.comment
            review.comments.insert(
                min(anchor.index, len(review.comments)),
                comment.model_copy(
                    update={
                        "timeline_start": at + comment.timeline_start,
                        "timeline_end": None
                        if comment.timeline_end is None
                        else at + comment.timeline_end,
                    }
                ),
            )
