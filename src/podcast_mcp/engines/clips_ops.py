from __future__ import annotations

import hashlib
import hmac
import math
import uuid
from collections.abc import Mapping, Sequence
from itertools import pairwise
from typing import Any, Literal

from podcast_mcp.config.defaults import EffectiveConfig, join_micro_fade_ms
from podcast_mcp.engines.alignment_key import ingest_alignment_key
from podcast_mcp.engines.mute_regions import merge_mute_regions, mute_regions_overlapping
from podcast_mcp.engines.ranges import SPAN_EPS_S
from podcast_mcp.engines.session_timeline import (
    clip_timeline_overlap_to_source,
    clip_timeline_point_to_source,
)
from podcast_mcp.models import Clip, ClipJoinMode, EditMode, EpisodeProject, SourceRecording
from podcast_mcp.util.batch_scope import scoped
from podcast_mcp.util.coded_error import CodedError, CodedValueError
from podcast_mcp.util.contracts import contract_constant
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.tracks import recording_audio_path, unknown_track
from podcast_mcp.util.workspace_paths import workspace_relpath

JOIN_GAP_TOLERANCE_SEC: float = contract_constant(
    "join-length-limits.json", "join_gap_tolerance_sec"
)
"""Largest timeline gap (seconds) between neighbouring clips still treated as a join."""


def new_clip_id() -> str:
    return f"clip_{uuid.uuid4().hex[:8]}"


def _split_parents() -> dict[str, str]:
    return scoped("clip_split_parents", dict)


def clip_split_origin(clip_id: str | None, before_ids: set[str | None]) -> str | None:
    parents = _split_parents()
    while clip_id is not None and clip_id not in before_ids and clip_id in parents:
        clip_id = parents[clip_id]
    return clip_id


def clips_for_track(project: EpisodeProject, track_id: str) -> list[Clip]:
    return sorted(
        (c for c in project.clips if c.track_id == track_id),
        key=lambda c: c.timeline_start,
    )


def clips_abut(left: Clip, right: Clip) -> bool:
    """True when ``right`` starts within :data:`JOIN_GAP_TOLERANCE_SEC` of ``left``'s end.

    The single join rule shared by clip editing, audio audit and rendering. Overlaps
    (negative gaps) also count as abutting.
    """
    return right.timeline_start - left.timeline_end <= JOIN_GAP_TOLERANCE_SEC


def abutting_pairs(clips: Sequence[Clip]) -> list[tuple[Clip, Clip]]:
    """Neighbouring ``(left, right)`` pairs of timeline-sorted ``clips`` that form a join."""
    return [(left, right) for left, right in pairwise(clips) if clips_abut(left, right)]


SPLICE_SOURCE_EPS_SEC = 1e-4
"""Smallest source discontinuity (seconds) between neighbouring clips that counts as a splice."""


def is_splice(left: Clip, right: Clip) -> bool:
    """True when ``right`` does not resume where ``left`` stopped in the source.

    A split clip (continuous source) is not a splice; a cut, a ripple delete or a
    clip moved in from another source is. The single rule shared by join QA and
    the audition context.
    """
    if left.source_id != right.source_id:
        return True
    return abs(float(right.source_start) - float(left.source_end)) >= SPLICE_SOURCE_EPS_SEC


def splice_joins(clips: Sequence[Clip]) -> list[tuple[Clip, Clip]]:
    """Neighbouring ``(left, right)`` pairs of timeline-sorted ``clips`` whose source is discontinuous."""
    return [(left, right) for left, right in pairwise(clips) if is_splice(left, right)]


JOIN_INSTANT_EPS_SEC = 1e-3
"""Clip edges within this many timeline seconds of each other sit on one join instant."""


def clip_edges_at(
    project: EpisodeProject, timeline_sec: float, edge: str
) -> dict[str, Clip | None]:
    """Per dialogue track, the clip whose ``in`` (start) or ``out`` (end) edge sits at ``timeline_sec``.

    A session-wide cut (ripple) leaves an edge on every track at the same instant; a
    track-local punch leaves one on its own track only. ``None`` marks a track without
    an edge there.
    """
    from podcast_mcp.util.tracks import dialogue_track_ids

    if edge not in ("in", "out"):
        raise CodedValueError(
            f"edge must be 'in' or 'out', got {edge!r}. Pass \"in\" or \"out\".",
            code="edge_invalid",
        )
    out: dict[str, Clip | None] = {}
    for tid in dialogue_track_ids(project):
        out[tid] = next(
            (
                c
                for c in clips_for_track(project, tid)
                if abs((c.timeline_start if edge == "in" else c.timeline_end) - timeline_sec)
                <= JOIN_INSTANT_EPS_SEC
            ),
            None,
        )
    return out


def is_session_join(project: EpisodeProject, timeline_sec: float, edge: str) -> bool:
    """True when every dialogue track has a clip edge at ``timeline_sec``."""
    edges = clip_edges_at(project, timeline_sec, edge)
    return bool(edges) and all(c is not None for c in edges.values())


def set_track_clips(project: EpisodeProject, track_id: str, clips: list[Clip]) -> None:
    track = project.track_by_id(track_id)
    previous = clips_for_track(project, track_id)
    if track is not None:
        if clips:
            track.timeline_empty = False
        elif previous:
            track.timeline_empty = True
    entries = project.meta.ingest_alignment
    if track is not None and entries:
        old_ids = {clip.id for clip in previous}
        for original in previous:
            entry = entries.get(ingest_alignment_key(track, original, per_clip=True))
            if entry is None or entry.align_method != "manual":
                continue
            for clip in clips:
                if (
                    clip.id not in old_ids
                    and clip.source_id == original.source_id
                    and clip.source_start >= original.source_start - 1e-9
                    and clip.source_end <= original.source_end + 1e-9
                ):
                    entries.setdefault(
                        ingest_alignment_key(track, clip, per_clip=True), entry.model_copy()
                    )
    project.clips = [c for c in project.clips if c.track_id != track_id] + clips


def split_clip_at(
    clip: Clip, timeline_time: float, *, defaults: EffectiveConfig
) -> tuple[Clip, Clip]:
    """Split clip at session timeline position."""
    tl_end = clip.timeline_end
    if timeline_time <= clip.timeline_start + 1e-9 or timeline_time >= tl_end - 1e-9:
        raise CodedValueError(
            "split time must be strictly inside clip timeline bounds. Pick a time between the clip's start and end.",
            code="split_outside_clip",
        )
    source_split = clip_timeline_point_to_source(clip, timeline_time)
    fade = join_micro_fade_ms(defaults=defaults)
    before = clip.model_copy(
        deep=True,
        update={
            "id": new_clip_id(),
            "source_end": source_split,
            "fade_out_ms": max(clip.fade_out_ms, fade),
        },
    )
    after = clip.model_copy(
        deep=True,
        update={
            "id": new_clip_id(),
            "source_start": source_split,
            "timeline_start": timeline_time,
            "fade_in_ms": max(clip.fade_in_ms, fade),
            "join_in_mode": ClipJoinMode.FADE,
        },
    )
    before.mute_regions = mute_regions_overlapping(
        clip.mute_regions, before.source_start, before.source_end
    )
    after.mute_regions = mute_regions_overlapping(
        clip.mute_regions, after.source_start, after.source_end
    )
    _split_parents().update({before.id: clip.id, after.id: clip.id})
    return before, after


def shift_clips_timeline(clips: list[Clip], from_time: float, delta_sec: float) -> None:
    for c in clips:
        if c.timeline_start >= from_time - 1e-9:
            c.timeline_start += delta_sec


def remove_timeline_range_from_clips(
    clips: list[Clip],
    timeline_start: float,
    timeline_end: float,
    *,
    defaults: EffectiveConfig,
) -> list[Clip]:
    """Remove [timeline_start, timeline_end) from clip list; ripple subsequent clips."""
    if timeline_end <= timeline_start:
        return clips
    duration = timeline_end - timeline_start
    out: list[Clip] = []
    for clip in clips:
        tl_end = clip.timeline_end
        if tl_end <= timeline_start + 1e-9 or clip.timeline_start >= timeline_end - 1e-9:
            if clip.timeline_start >= timeline_end - 1e-9:
                out.append(
                    clip.model_copy(
                        deep=True, update={"timeline_start": clip.timeline_start - duration}
                    )
                )
            else:
                out.append(clip)
            continue

        if clip.timeline_start >= timeline_start - 1e-9 and tl_end <= timeline_end + 1e-9:
            continue

        working = clip
        if working.timeline_start < timeline_start - SPAN_EPS_S:
            before, working = split_clip_at(working, timeline_start, defaults=defaults)
            out.append(before)

        tl_end = working.timeline_end
        if tl_end > timeline_end + 1e-9:
            _, after = split_clip_at(working, timeline_end, defaults=defaults)
            out.append(
                after.model_copy(
                    deep=True, update={"timeline_start": after.timeline_start - duration}
                )
            )
    return sorted(out, key=lambda c: c.timeline_start)


def punch_timeline_range_from_clips(
    clips: list[Clip],
    timeline_start: float,
    timeline_end: float,
    *,
    defaults: EffectiveConfig,
) -> list[Clip]:
    """Remove audio in [timeline_start, timeline_end) but keep timeline length.

    Leaves a silence hole so peer tracks stay aligned (no ripple shift).
    """
    if timeline_end <= timeline_start:
        return clips
    out: list[Clip] = []
    for clip in clips:
        tl_end = clip.timeline_end
        if tl_end <= timeline_start + 1e-9 or clip.timeline_start >= timeline_end - 1e-9:
            out.append(clip)
            continue

        if clip.timeline_start >= timeline_start - 1e-9 and tl_end <= timeline_end + 1e-9:
            # Fully inside the punch - drop (silence hole remains).
            continue

        working = clip
        if working.timeline_start < timeline_start:
            before, working = split_clip_at(working, timeline_start, defaults=defaults)
            out.append(before)

        tl_end = working.timeline_end
        if tl_end > timeline_end + 1e-9:
            _, after = split_clip_at(working, timeline_end, defaults=defaults)
            # Keep after at timeline_end (no shift) so the hole duration is preserved.
            out.append(after)
    return sorted(out, key=lambda c: c.timeline_start)


def extract_clips_in_timeline_range(
    clips: list[Clip],
    timeline_start: float,
    timeline_end: float,
) -> list[Clip]:
    """Return new clip copies for content in [timeline_start, timeline_end)."""
    extracted: list[Clip] = []
    for clip in clips:
        tl_end = clip.timeline_end
        ov_start = max(timeline_start, clip.timeline_start)
        ov_end = min(timeline_end, tl_end)
        if ov_end <= ov_start + 1e-9:
            continue
        src_bounds = clip_timeline_overlap_to_source(clip, ov_start, ov_end)
        if src_bounds is None:
            continue
        src_start, src_end = src_bounds
        extracted.append(
            Clip(
                id=new_clip_id(),
                track_id=clip.track_id,
                source_start=src_start,
                source_end=src_end,
                timeline_start=ov_start - timeline_start,
                source_id=clip.source_id,
                fade_in_ms=clip.fade_in_ms,
                fade_out_ms=clip.fade_out_ms,
                join_in_mode=clip.join_in_mode,
                mute_regions=mute_regions_overlapping(clip.mute_regions, src_start, src_end),
                off_speaker_mute_regions=[
                    r.model_copy(deep=True) for r in clip.off_speaker_mute_regions
                ],
                bleed_restore=clip.bleed_restore.model_copy(deep=True)
                if clip.bleed_restore
                else None,
            )
        )
    return extracted


def place_clips_at(
    clips: list[Clip],
    extracted: list[Clip],
    insert_at: float,
) -> list[Clip]:
    """Insert extracted clips (relative timeline) at insert_at on a track."""
    placed = [
        c.model_copy(deep=True, update={"timeline_start": insert_at + c.timeline_start})
        for c in extracted
    ]
    merged = clips + placed
    return sorted(merged, key=lambda c: c.timeline_start)


def update_timeline_duration(project: EpisodeProject) -> None:
    end = 0.0
    for clip in project.clips:
        end = max(end, clip.timeline_end)
    project.timeline.duration_sec = end if end > 0 else project.timeline.duration_sec


_MIN_CLIP_SPAN_SEC: float = contract_constant("trim-edge-limits.json", "min_clip_span_sec")


def source_duration_sec(project: EpisodeProject, clip: Clip) -> float | None:
    """Length of the recording ``clip`` plays: its source's, else its track media's; ``None`` if unmeasured."""
    if clip.source_id is not None:
        source = project.source_by_id(clip.source_id)
        if source is None:
            raise CodedValueError(
                f"unknown source recording {clip.source_id!r}", code="clip_source_missing"
            )
        return float(source.duration_sec) if source.duration_sec is not None else None
    track = project.track_by_id(clip.track_id)
    if track is None or track.media is None or track.media.duration_sec is None:
        return None
    return float(track.media.duration_sec)


def recording_key(project: EpisodeProject, clip: Clip, *, secret: bytes) -> str | None:
    """Opaque identity of the recording ``clip`` plays; ``None`` when it has none.

    Keys are workspace-scoped, with ``rec_`` followed by 16 lowercase hex digits.
    Clips playing the same file share a key. The key names no recording file.
    """
    try:
        path = workspace_relpath(
            project,
            recording_audio_path(project, clip.track_id, clip.source_id, from_project=True),
        )
    except (CodedError, ValueError):
        return None
    workspace = project.workspace_path().expanduser().resolve()
    message = f"podcast-mcp:recording-key:v1\0{workspace}\0{path}".encode()
    return f"rec_{hmac.new(secret, message, hashlib.sha256).hexdigest()[:16]}"


def _same_recording(project: EpisodeProject, first: Clip, second: Clip) -> bool:
    if first.track_id == second.track_id and first.source_id == second.source_id:
        return True
    return same_recording(
        recording_audio_path(project, first.track_id, first.source_id, from_project=True),
        recording_audio_path(project, second.track_id, second.source_id, from_project=True),
    )


def trim_edge_limits(
    project: EpisodeProject, clip: Clip, edge: str, mode: EditMode
) -> tuple[float, float]:
    """Source range ``(lo, hi)`` a clip's ``in`` or ``out`` edge may move to.

    Expansion stops at the neighbouring clip's source on the same track (and at the
    media end when known); contraction keeps ``_MIN_CLIP_SPAN_SEC`` of the clip. A gap
    trim moves only this edge, so it also stops at the next clip on the timeline (out)
    or the previous clip's end or timeline 0 (in).
    """
    if edge not in ("in", "out"):
        raise CodedValueError(
            f"edge must be 'in' or 'out', got {edge!r}. Pass \"in\" or \"out\".",
            code="edge_invalid",
        )
    track_clips = clips_for_track(project, clip.track_id)
    idx = clip_index(track_clips, clip.id)
    prev = previous_clip(track_clips, clip.id)
    nxt = track_clips[idx + 1] if idx + 1 < len(track_clips) else None
    others = [c for c in track_clips if c.id != clip.id]
    if edge == "out":
        duration = source_duration_sec(project, clip)
        hi = duration if duration is not None else clip.source_end
        if nxt is not None and _same_recording(project, clip, nxt):
            hi = min(hi, float(nxt.source_start))
        if mode is EditMode.GAP:
            following = [
                c.timeline_start
                for c in others
                if c.timeline_start >= clip.timeline_end - SPAN_EPS_S
            ]
            if following:
                room = min(following) - clip.timeline_end
                hi = min(hi, clip.source_end + max(0.0, room))
        return clip.source_start + _MIN_CLIP_SPAN_SEC, hi
    lo = (
        max(0.0, float(prev.source_end))
        if prev is not None and _same_recording(project, clip, prev)
        else 0.0
    )
    if mode is EditMode.GAP:
        preceding = max(
            (c.timeline_end for c in others if c.timeline_end <= clip.timeline_start + SPAN_EPS_S),
            default=0.0,
        )
        room = clip.timeline_start - preceding
        lo = max(lo, clip.source_start - max(0.0, room))
    return lo, clip.source_end - _MIN_CLIP_SPAN_SEC


CrossfadeBlocked = Literal["not_abutting", "no_fade_out", "no_fade_in", "no_headroom"]


def crossfade_block_reason(
    left: Clip, right: Clip, project: EpisodeProject | None = None
) -> CrossfadeBlocked | None:
    """Why a crossfade-mode join renders as a plain fade/cut, or ``None`` when it blends.

    With ``project`` it also reports ``no_headroom``: the recordings have no room to
    borrow from at the seam (or a length is unmeasured), so render plays the fades.
    """
    if not clips_abut(left, right):
        return "not_abutting"
    if left.fade_out_ms <= 0:
        return "no_fade_out"
    if right.fade_in_ms <= 0:
        return "no_fade_in"
    if project is not None and crossfade_borrow_sec(project, left, right) <= 0:
        return "no_headroom"
    return None


def uses_crossfade_join(prev: Clip, clip: Clip) -> bool:
    """True when render blends ``prev`` into ``clip`` with an overlapping crossfade."""
    return (
        clip.join_in_mode == ClipJoinMode.CROSSFADE and crossfade_block_reason(prev, clip) is None
    )


def crossfade_ms_at_join(left: Clip, right: Clip) -> int:
    """Overlap (ms) render uses at the join, ``0`` when it is not a crossfade."""
    if not uses_crossfade_join(left, right):
        return 0
    vals = [left.fade_out_ms, right.fade_in_ms]
    return max(min(vals), max(vals) // 2)


def crossfade_borrow_sec(project: EpisodeProject, left: Clip, right: Clip) -> float:
    """Seconds each side of a blending join borrows from its recording (half the overlap).

    The blend is centred on the seam: ``left`` plays on past its end and ``right``
    starts before its start, each by this much, so the join adds and removes no
    time on the lane. The borrow shrinks to the room the recordings have beyond
    the two edges (an unmeasured recording has none) and to a quarter of either
    clip, so the two joins of a short clip never meet. ``0`` when the join does
    not blend.
    """
    ms = crossfade_ms_at_join(left, right)
    if ms <= 0:
        return 0.0
    left_total = source_duration_sec(project, left)
    right_total = source_duration_sec(project, right)
    if left_total is None or right_total is None:
        return 0.0
    room = min(
        ms / 2000.0,
        left_total - left.source_end,
        right.source_start,
        (left.source_end - left.source_start) * 0.25,
        (right.source_end - right.source_start) * 0.25,
    )
    return room if room >= 0.0005 else 0.0


def join_render_fields(
    prev: Clip | None, clip: Clip, project: EpisodeProject | None = None
) -> dict[str, Any]:
    """Effective render of the join into ``clip`` (flat fields for ``list_clips`` rows).

    With ``project`` the fields are what render does given the recordings' lengths:
    ``join_borrow_sec`` (present only while the join blends) is the seconds each
    side borrows and ``join_crossfade_ms`` the overlap that gives (twice it).
    """
    if prev is None:
        return {
            "join_left_clip_id": None,
            "join_render_mode": None,
            "join_crossfade_ms": 0,
            "join_crossfade_blocked": None,
        }
    blocked = (
        crossfade_block_reason(prev, clip, project)
        if clip.join_in_mode == ClipJoinMode.CROSSFADE
        else None
    )
    borrow = (
        crossfade_borrow_sec(project, prev, clip)
        if project is not None and clip.join_in_mode == ClipJoinMode.CROSSFADE and blocked is None
        else 0.0
    )
    overlap_ms = round(borrow * 2000) if project is not None else crossfade_ms_at_join(prev, clip)
    return {
        "join_left_clip_id": prev.id,
        "join_render_mode": (
            "crossfade"
            if clip.join_in_mode == ClipJoinMode.CROSSFADE and blocked is None
            else clip.join_in_mode.value
        ),
        "join_crossfade_ms": overlap_ms if blocked is None else 0,
        "join_crossfade_blocked": blocked,
        # Only while a join borrows, so rows of joins that do not blend stay as they were.
        **({"join_borrow_sec": borrow} if borrow > 0 else {}),
    }


def clip_index(track_clips: Sequence[Clip], clip_id: str) -> int:
    """Index of ``clip_id`` in ``track_clips``; ``ValueError`` when it is not there."""
    idx = next((i for i, c in enumerate(track_clips) if c.id == clip_id), None)
    if idx is None:
        raise CodedValueError(f"unknown clip_id: {clip_id!r}", code="clip_not_found")
    return idx


def previous_clip(track_clips: Sequence[Clip], clip_id: str) -> Clip | None:
    """Clip before ``clip_id`` in ``track_clips`` (None for the first); ``ValueError`` if absent."""
    idx = clip_index(track_clips, clip_id)
    return track_clips[idx - 1] if idx > 0 else None


def neighbour_clips(
    project: EpisodeProject,
    left_clip_id: str,
    right_clip_id: str,
) -> tuple[Clip, Clip, list[Clip], int]:
    """Resolve ``left``/``right`` as adjacent clips on one track.

    Returns ``(left, right, track_clips, left_index)``; raises ``ValueError`` otherwise.
    """
    left = next((c for c in project.clips if c.id == left_clip_id), None)
    right = next((c for c in project.clips if c.id == right_clip_id), None)
    if left is None:
        raise CodedValueError(f"unknown left_clip_id: {left_clip_id!r}", code="clip_not_found")
    if right is None:
        raise CodedValueError(f"unknown right_clip_id: {right_clip_id!r}", code="clip_not_found")
    if left.track_id != right.track_id:
        raise CodedValueError(
            "join requires clips on the same track. Pick two neighbouring clips on one track.",
            code="clips_not_adjacent",
        )
    track_clips = clips_for_track(project, left.track_id)
    left_idx = clip_index(track_clips, left_clip_id)
    if left_idx + 1 >= len(track_clips) or track_clips[left_idx + 1].id != right_clip_id:
        raise CodedValueError(
            "right clip must be the next clip after left on the track. Pick two neighbouring clips on one track.",
            code="clips_not_adjacent",
        )
    return left, right, track_clips, left_idx


def roll_clip_join(
    project: EpisodeProject,
    left_clip_id: str,
    right_clip_id: str,
    delta_sec: float,
) -> tuple[Clip, Clip]:
    """Roll the join between two abutting clips on the same track.

    Both edges move by the same source delta (left ``source_end``, right
    ``source_start``). Clips stay timeline-flush; the pair's total duration is
    unchanged so later clips do not ripple. Cutaway gap size is preserved when
    both edges move equally. Clips over one recording share the union of their mute
    regions, since the join can hand a muted span from one to the other.
    """
    if not math.isfinite(delta_sec):
        raise CodedValueError(
            "delta_sec must be finite. Pass a finite number of seconds.",
            code="delta_sec_not_finite",
        )
    left, right, _, _ = neighbour_clips(project, left_clip_id, right_clip_id)

    lo, hi = roll_join_limits(project, left_clip_id, right_clip_id)
    delta = min(max(float(delta_sec), lo), hi)
    if abs(delta) < 1e-12:
        return left, right

    left.source_end += delta
    right.source_start += delta
    right.timeline_start = left.timeline_end
    if _same_recording(project, left, right):
        shared = merge_mute_regions(left.mute_regions + right.mute_regions)
        left.mute_regions = shared
        right.mute_regions = [r.model_copy() for r in shared]
    update_timeline_duration(project)
    return left, right


def roll_join_limits(
    project: EpisodeProject, left_clip_id: str, right_clip_id: str
) -> tuple[float, float]:
    """Legal source-clock delta for a roll, shared by UI context and mutation.

    Refuses clips with a gap between them (``roll_needs_abutting_clips``): a roll keeps
    the pair flush, so it would pull the right clip across the gap.
    """
    left, right, track_clips, left_idx = neighbour_clips(project, left_clip_id, right_clip_id)
    if not clips_abut(left, right):
        raise CodedValueError(
            "These clips have a gap between them, so there is no join to roll. "
            "Move one clip to touch the other, or trim an edge instead.",
            code="roll_needs_abutting_clips",
        )
    prev = track_clips[left_idx - 1] if left_idx > 0 else None
    nxt = track_clips[left_idx + 2] if left_idx + 2 < len(track_clips) else None
    left_duration = source_duration_sec(project, left)
    left_room = (left_duration - left.source_end) if left_duration is not None else 0.0
    max_pos = min(left_room, right.source_end - right.source_start - _MIN_CLIP_SPAN_SEC)
    if nxt is not None and _same_recording(project, right, nxt):
        max_pos = min(max_pos, float(nxt.source_start) - right.source_start)
    right_floor = (
        float(prev.source_end)
        if prev is not None and _same_recording(project, right, prev)
        else 0.0
    )
    max_neg = min(
        left.source_end - left.source_start - _MIN_CLIP_SPAN_SEC,
        right.source_start - right_floor,
    )
    return -max(0.0, max_neg), max(0.0, max_pos)


def pin_clip_source_id(project: EpisodeProject, clip: Clip) -> None:
    """Bind ``clip.source_id`` to the media currently on its track.

    Required before changing ``track_id`` so render keeps the originating file
    (``resolve_clip_audio_path`` falls back to destination ``track.media``).
    """
    if clip.source_id and project.source_by_id(clip.source_id) is not None:
        return
    track = project.track_by_id(clip.track_id)
    if track is None or track.media is None:
        return
    path = track.media.path
    existing = next((s for s in project.sources if s.path == path), None)
    if existing is None:
        sid = f"src_{uuid.uuid4().hex[:8]}"
        project.sources.append(
            SourceRecording(
                id=sid,
                path=path,
                duration_sec=track.media.duration_sec,
                sample_rate=track.media.sample_rate,
                channels=track.media.channels,
            )
        )
        clip.source_id = sid
        return
    clip.source_id = existing.id


def move_clips(project: EpisodeProject, moves: Sequence[Mapping[str, Any]]) -> list[Clip]:
    """Reposition clips in time and/or onto another track (no shuffle/ripple).

    Each item is ``{clip_id, timeline_start, track_id}``. Gaps and overlap are
    allowed. Inter-track moves pin ``source_id`` to the originating media.
    """
    if not moves:
        raise CodedValueError(
            "clips must be a non-empty list. Pass at least one clip to move.",
            code="missing_argument",
        )
    seen: set[str] = set()
    parsed: list[tuple[Clip, float, str]] = []
    for raw in moves:
        cid = str(raw["clip_id"])
        if cid in seen:
            raise CodedValueError(
                f"duplicate clip_id: {cid!r}. Name each clip once.", code="duplicate_clip_id"
            )
        seen.add(cid)
        clip = next((c for c in project.clips if c.id == cid), None)
        if clip is None:
            raise CodedValueError(f"unknown clip_id: {cid!r}", code="clip_not_found")
        tl = float(raw["timeline_start"])
        if not math.isfinite(tl) or tl < 0:
            raise CodedValueError(
                f"timeline_start must be >= 0, got {tl!r}. Pick a start at or after 0.",
                code="out_of_range",
            )
        tid = str(raw["track_id"])
        if project.track_by_id(tid) is None:
            raise unknown_track(tid)
        parsed.append((clip, tl, tid))
    for clip, tl, tid in parsed:
        if tid != clip.track_id:
            pin_clip_source_id(project, clip)
            if not clip.source_id:
                raise CodedValueError(
                    f"cannot move clip {clip.id!r} to another track without origin media. Move it within its own track instead.",
                    code="clip_move_needs_media",
                )
            clip.track_id = tid
        destination = project.track_by_id(tid)
        if destination is not None:
            destination.timeline_empty = False
        clip.timeline_start = tl
    update_timeline_duration(project)
    return [c for c, _, _ in parsed]
