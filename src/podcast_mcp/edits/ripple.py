"""Edit modes: which tracks a ripple moves, the time it removes, and trim plans.

A ripple (:class:`EditMode.RIPPLE`) closes or opens time on every track
:func:`ripple_track_ids` names, so speakers stay in sync. A gap edit
(:class:`EditMode.GAP`) leaves silence on the edited track and moves nothing else.
Rippling edits plan their removal first (:class:`RippleRemoval`), so the speech
guard (``edits/cut_speech.py``) can check it before anything changes.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

from podcast_mcp.edits.clips_ops import (
    clips_for_track,
    remove_timeline_range_from_clips,
    set_track_clips,
    shift_clips_timeline,
    split_clip_at,
    trim_edge_limits,
    update_timeline_duration,
)
from podcast_mcp.models import Clip, EditMode, EpisodeProject
from podcast_mcp.util.intervals import merge_intervals
from podcast_mcp.util.tracks import dialogue_track_ids

TrimEdge = Literal["in", "out"]

_EDGE_EPS_SEC = 1e-3
_EPS = 1e-9


def ripple_track_ids(project: EpisodeProject, edited_track_ids: Iterable[str] = ()) -> list[str]:
    """Tracks a ripple moves: every dialogue track, then any edited track that is not one.

    The one scope rule for every rippling edit, so a ripple never moves one speaker
    without the others.
    """
    tracks = dialogue_track_ids(project)
    extra = [
        tid
        for tid in dict.fromkeys(edited_track_ids)
        if tid not in tracks and project.track_by_id(tid) is not None
    ]
    return tracks + extra


@dataclass(frozen=True)
class TrackExtent:
    """Time on one track that an edit chose to cut: a deleted clip, a named track's range."""

    track_id: str
    start: float
    end: float


@dataclass(frozen=True)
class RippleRemoval:
    """What a ripple removes, planned before anything changes.

    ``spans`` are the disjoint timeline spans, in order, closed on every scope track.
    ``selected`` is what the edit chose to cut, each extent on its own track and never
    merged across tracks: speech inside a span but outside its own track's selected
    extents belongs to someone the edit did not name, so the guard asks about it.
    """

    spans: tuple[tuple[float, float], ...]
    selected: tuple[TrackExtent, ...]

    @classmethod
    def of(
        cls,
        selected: Iterable[TrackExtent] = (),
        *,
        unselected: Iterable[tuple[float, float]] = (),
    ) -> RippleRemoval:
        """Spans covering ``selected`` plus ``unselected`` time no track chose to cut."""
        extents = tuple(e for e in selected if e.end > e.start + _EPS)
        spans = merge_intervals(
            [(e.start, e.end) for e in extents] + [(s, e) for s, e in unselected if e > s + _EPS],
            gap=_EPS,
        )
        if not spans:
            raise ValueError("a ripple removal needs a span with end after start")
        return cls(tuple(spans), extents)

    @property
    def edited_track_ids(self) -> frozenset[str]:
        return frozenset(e.track_id for e in self.selected)

    def unselected_on(self, track_id: str, start: float, end: float) -> list[tuple[float, float]]:
        """Parts of ``[start, end)`` that ``track_id``'s selected extents do not cover."""
        parts = [(start, end)]
        for extent in self.selected:
            if extent.track_id != track_id:
                continue
            parts = [
                piece
                for lo, hi in parts
                for piece in ((lo, min(hi, extent.start)), (max(lo, extent.end), hi))
                if piece[1] > piece[0] + _EPS
            ]
        return parts


def ripple_remove_clips(
    project: EpisodeProject, spans: Sequence[tuple[float, float]], track_ids: Iterable[str]
) -> dict[str, list[Clip]]:
    """Remove disjoint ``spans`` from ``track_ids`` and close them up; returns clips before."""
    before: dict[str, list[Clip]] = {}
    for tid in track_ids:
        clips = before[tid] = clips_for_track(project, tid)
        for start, end in sorted(spans, reverse=True):
            clips = remove_timeline_range_from_clips(clips, start, end)
        set_track_clips(project, tid, clips)
    update_timeline_duration(project)
    return before


def ripple_insert_clips(
    project: EpisodeProject, at_time: float, duration_sec: float, track_ids: Iterable[str]
) -> None:
    """Open ``duration_sec`` of silence at ``at_time`` on ``track_ids``, splitting a clip there."""
    if duration_sec <= 0:
        raise ValueError("duration_sec must be positive")
    for tid in track_ids:
        split: list[Clip] = []
        for clip in clips_for_track(project, tid):
            if clip.timeline_start + _EPS < at_time < clip.timeline_end - _EPS:
                split.extend(split_clip_at(clip, at_time))
            else:
                split.append(clip)
        shift_clips_timeline(split, at_time, duration_sec)
        set_track_clips(project, tid, split)
    update_timeline_duration(project)


@dataclass(frozen=True)
class EdgeMove:
    """A clip edge a trim moves to ``source_sec``."""

    clip_id: str
    track_id: str
    source_sec: float


@dataclass(frozen=True)
class TrimPlan:
    """What one trim does, computed before anything changes.

    ``delta`` is the clip's duration change (negative shortens). A ripple moves the
    trimmed clip's edge and the same edge of any scope track's clip at that instant
    (``moves``), shifts what follows on those tracks by ``delta``, and on the other
    scope tracks removes the shortened span (``removal``) or opens ``delta`` of
    silence at the instant. A gap trim only moves the trimmed edge.
    """

    clip_id: str
    track_id: str
    edge: TrimEdge
    mode: EditMode
    instant: float
    delta: float
    moves: tuple[EdgeMove, ...]
    scope: tuple[str, ...]
    removal: RippleRemoval | None

    @property
    def unchanged(self) -> bool:
        return abs(self.delta) < 1e-12

    @property
    def track_ids(self) -> list[str]:
        return list(self.scope) if self.scope else [self.track_id]


def _edge_sec(clip: Clip, edge: TrimEdge) -> float:
    return clip.source_start if edge == "in" else clip.source_end


def _timeline_edge(clip: Clip, edge: TrimEdge) -> float:
    return clip.timeline_start if edge == "in" else clip.timeline_end


def _shifted_edge(clip: Clip, edge: TrimEdge, delta: float) -> float:
    """Source position of ``clip``'s edge after its duration changes by ``delta``."""
    return _edge_sec(clip, edge) - delta if edge == "in" else _edge_sec(clip, edge) + delta


def plan_trim(
    project: EpisodeProject,
    clip_id: str,
    edge: TrimEdge,
    source_sec: float,
    mode: EditMode,
) -> TrimPlan:
    """Plan moving ``clip_id``'s edge toward ``source_sec``, clamped to its legal limits."""
    if not math.isfinite(source_sec):
        raise ValueError("source_sec must be finite")
    if edge not in ("in", "out"):
        raise ValueError(f"edge must be 'in' or 'out', got {edge!r}")
    clip = next((c for c in project.clips if c.id == clip_id), None)
    if clip is None:
        raise ValueError(f"unknown clip_id: {clip_id!r}")
    lo, hi = trim_edge_limits(project, clip, edge, mode)
    target = min(max(float(source_sec), lo), hi)
    old = _edge_sec(clip, edge)
    delta = old - target if edge == "in" else target - old
    instant = _timeline_edge(clip, edge)
    moves = [EdgeMove(clip.id, clip.track_id, target)]
    if mode is EditMode.GAP or abs(delta) < 1e-12:
        return TrimPlan(clip.id, clip.track_id, edge, mode, instant, delta, tuple(moves), (), None)
    scope = ripple_track_ids(project, [clip.track_id])
    for tid in scope:
        if tid == clip.track_id:
            continue
        peer = next(
            (
                c
                for c in clips_for_track(project, tid)
                if abs(_timeline_edge(c, edge) - instant) <= _EDGE_EPS_SEC
            ),
            None,
        )
        if peer is None:
            continue
        peer_target = _shifted_edge(peer, edge, delta)
        peer_lo, peer_hi = trim_edge_limits(project, peer, edge, EditMode.RIPPLE)
        # A peer that cannot move its own edge as far takes the span instead.
        if peer_lo - _EPS <= peer_target <= peer_hi + _EPS:
            moves.append(EdgeMove(peer.id, tid, peer_target))
    removal = None
    if delta < 0:
        start, end = (instant + delta, instant) if edge == "out" else (instant, instant - delta)
        removal = RippleRemoval.of([TrackExtent(clip.track_id, start, end)])
    return TrimPlan(
        clip.id, clip.track_id, edge, mode, instant, delta, tuple(moves), tuple(scope), removal
    )


def apply_trim_geometry(project: EpisodeProject, plan: TrimPlan) -> dict[str, list[Clip]]:
    """Apply ``plan``'s clip geometry; returns the clips before for tracks that lost a span."""
    by_id = {c.id: c for c in project.clips}
    for move in plan.moves:
        clip = by_id[move.clip_id]
        old_end = clip.timeline_end
        if plan.edge == "out":
            clip.source_end = move.source_sec
        else:
            moved = move.source_sec - clip.source_start
            clip.source_start = move.source_sec
            if plan.mode is EditMode.GAP:
                clip.timeline_start += moved
        if plan.mode is EditMode.RIPPLE:
            for other in clips_for_track(project, move.track_id):
                if other.id != clip.id and other.timeline_start >= old_end - _EPS:
                    other.timeline_start += plan.delta
    moved_tracks = {move.track_id for move in plan.moves}
    rest = [tid for tid in plan.scope if tid not in moved_tracks]
    before: dict[str, list[Clip]] = {}
    if plan.removal is not None:
        before = ripple_remove_clips(project, plan.removal.spans, rest)
    elif plan.mode is EditMode.RIPPLE and plan.delta > 0 and rest:
        ripple_insert_clips(project, plan.instant, plan.delta, rest)
    update_timeline_duration(project)
    return before
