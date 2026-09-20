from __future__ import annotations

import math
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.mute_regions import intersect_mute_regions
from podcast_mcp.edits.ranges import subtract_ranges_from_intervals
from podcast_mcp.engines.session_timeline import (
    clip_timeline_overlap_to_source,
    clip_timeline_point_to_source,
)
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, SourceRecording


def new_clip_id() -> str:
    return f"clip_{uuid.uuid4().hex[:8]}"


def clips_for_track(project: EpisodeProject, track_id: str) -> list[Clip]:
    return sorted(
        (c for c in project.clips if c.track_id == track_id),
        key=lambda c: c.timeline_start,
    )


def set_track_clips(project: EpisodeProject, track_id: str, clips: list[Clip]) -> None:
    project.clips = [c for c in project.clips if c.track_id != track_id] + clips


def split_clip_at(clip: Clip, timeline_time: float) -> tuple[Clip, Clip]:
    """Split clip at session timeline position."""
    tl_end = clip.timeline_end
    if timeline_time <= clip.timeline_start + 1e-9 or timeline_time >= tl_end - 1e-9:
        raise ValueError("split time must be strictly inside clip timeline bounds")
    source_split = clip_timeline_point_to_source(clip, timeline_time)
    fade = int(load_defaults().get("inaudible_cuts", {}).get("micro_fade_ms", 10))
    before = clip.model_copy(
        update={
            "id": new_clip_id(),
            "source_end": source_split,
            "fade_out_ms": max(clip.fade_out_ms, fade),
        }
    )
    after = clip.model_copy(
        update={
            "id": new_clip_id(),
            "source_start": source_split,
            "timeline_start": timeline_time,
            "fade_in_ms": max(clip.fade_in_ms, fade),
            "join_in_mode": ClipJoinMode.FADE,
        }
    )
    before.mute_regions = intersect_mute_regions(
        clip.mute_regions, before.source_start, before.source_end
    )
    after.mute_regions = intersect_mute_regions(
        clip.mute_regions, after.source_start, after.source_end
    )
    return before, after


def shift_clips_timeline(clips: list[Clip], from_time: float, delta_sec: float) -> None:
    for c in clips:
        if c.timeline_start >= from_time - 1e-9:
            c.timeline_start += delta_sec


def remove_timeline_range_from_clips(
    clips: list[Clip],
    timeline_start: float,
    timeline_end: float,
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
                    clip.model_copy(update={"timeline_start": clip.timeline_start - duration})
                )
            else:
                out.append(clip)
            continue

        if clip.timeline_start >= timeline_start - 1e-9 and tl_end <= timeline_end + 1e-9:
            continue

        working = clip
        if working.timeline_start < timeline_start:
            before, working = split_clip_at(working, timeline_start)
            out.append(before)

        tl_end = working.timeline_end
        if tl_end > timeline_end + 1e-9:
            _, after = split_clip_at(working, timeline_end)
            out.append(after.model_copy(update={"timeline_start": after.timeline_start - duration}))
    return sorted(out, key=lambda c: c.timeline_start)


def punch_timeline_range_from_clips(
    clips: list[Clip],
    timeline_start: float,
    timeline_end: float,
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
            before, working = split_clip_at(working, timeline_start)
            out.append(before)

        tl_end = working.timeline_end
        if tl_end > timeline_end + 1e-9:
            _, after = split_clip_at(working, timeline_end)
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
                mute_regions=intersect_mute_regions(clip.mute_regions, src_start, src_end),
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
        c.model_copy(update={"timeline_start": insert_at + c.timeline_start}) for c in extracted
    ]
    merged = clips + placed
    return sorted(merged, key=lambda c: c.timeline_start)


def build_clips_after_removes(
    project: EpisodeProject,
    track_id: str,
    removes: list[tuple[float, float]],
) -> list[Clip]:
    """Rebuild gapless track clips after batch-removing timeline ranges."""
    if not removes:
        return clips_for_track(project, track_id)

    keep_segments: list[tuple[float, float, float, float, Clip]] = []
    for clip in clips_for_track(project, track_id):
        tl_start = clip.timeline_start
        tl_end = clip.timeline_end
        for ks, ke in subtract_ranges_from_intervals([(tl_start, tl_end)], removes):
            src_bounds = clip_timeline_overlap_to_source(clip, ks, ke)
            if src_bounds is None:
                continue
            src_start, src_end = src_bounds
            keep_segments.append((ks, ke, src_start, src_end, clip))

    keep_segments.sort(key=lambda row: row[0])
    new_clips: list[Clip] = []
    timeline_cursor = 0.0
    for _ks, _ke, src_start, src_end, old in keep_segments:
        new_clips.append(
            Clip(
                id=new_clip_id(),
                track_id=track_id,
                source_start=src_start,
                source_end=src_end,
                timeline_start=timeline_cursor,
                source_id=old.source_id,
                fade_in_ms=old.fade_in_ms,
                fade_out_ms=old.fade_out_ms,
                join_in_mode=old.join_in_mode,
                mute_regions=intersect_mute_regions(old.mute_regions, src_start, src_end),
            )
        )
        timeline_cursor += src_end - src_start
    return new_clips


def update_timeline_duration(project: EpisodeProject) -> None:
    end = 0.0
    for clip in project.clips:
        end = max(end, clip.timeline_end)
    project.timeline.duration_sec = end if end > 0 else project.timeline.duration_sec


_MIN_CLIP_SPAN_SEC = 0.05


def trim_clip_edge(
    project: EpisodeProject,
    clip_id: str,
    edge: str,
    source_sec: float,
    *,
    mode: str = "ripple",
) -> Clip:
    """Adjust one clip source edge; ripple later clips when duration changes.

    ``edge`` is ``\"in\"`` (source_start) or ``\"out\"`` (source_end).
    Expansion is clamped to unused source between neighboring clips on the
    same track (and media duration when known). Timeline start is unchanged;
    duration delta ripples subsequent clips.
    """
    if mode != "ripple":
        raise ValueError(f"unsupported trim mode: {mode!r}")
    if edge not in ("in", "out"):
        raise ValueError(f"edge must be 'in' or 'out', got {edge!r}")

    clip = next((c for c in project.clips if c.id == clip_id), None)
    if clip is None:
        raise ValueError(f"unknown clip_id: {clip_id!r}")

    track_clips = clips_for_track(project, clip.track_id)
    idx = next(i for i, c in enumerate(track_clips) if c.id == clip_id)
    prev = track_clips[idx - 1] if idx > 0 else None
    nxt = track_clips[idx + 1] if idx + 1 < len(track_clips) else None

    track = project.track_by_id(clip.track_id)
    media_end = float("inf")
    if track is not None and track.media is not None and track.media.duration_sec is not None:
        media_end = float(track.media.duration_sec)

    old_dur = clip.source_end - clip.source_start
    old_tl_end = clip.timeline_end

    if edge == "out":
        lo = clip.source_start + _MIN_CLIP_SPAN_SEC
        hi = media_end
        if nxt is not None:
            hi = min(hi, float(nxt.source_start))
        new_end = min(max(float(source_sec), lo), hi)
        clip.source_end = new_end
    else:
        lo = 0.0
        if prev is not None:
            lo = max(lo, float(prev.source_end))
        hi = clip.source_end - _MIN_CLIP_SPAN_SEC
        new_start = min(max(float(source_sec), lo), hi)
        clip.source_start = new_start

    new_dur = clip.source_end - clip.source_start
    delta = new_dur - old_dur
    if abs(delta) > 1e-9:
        for c in project.clips:
            if c.track_id == clip.track_id and c.timeline_start >= old_tl_end - 1e-9:
                c.timeline_start += delta

    clip.mute_regions = intersect_mute_regions(
        clip.mute_regions, clip.source_start, clip.source_end
    )
    update_timeline_duration(project)
    return clip


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
    both edges move equally.
    """
    left = next((c for c in project.clips if c.id == left_clip_id), None)
    right = next((c for c in project.clips if c.id == right_clip_id), None)
    if left is None:
        raise ValueError(f"unknown left_clip_id: {left_clip_id!r}")
    if right is None:
        raise ValueError(f"unknown right_clip_id: {right_clip_id!r}")
    if left.track_id != right.track_id:
        raise ValueError("roll join requires clips on the same track")

    track_clips = clips_for_track(project, left.track_id)
    try:
        left_idx = next(i for i, c in enumerate(track_clips) if c.id == left_clip_id)
    except StopIteration as exc:
        raise ValueError(f"unknown left_clip_id: {left_clip_id!r}") from exc
    if left_idx + 1 >= len(track_clips) or track_clips[left_idx + 1].id != right_clip_id:
        raise ValueError("right clip must be the next clip after left on the track")

    prev = track_clips[left_idx - 1] if left_idx > 0 else None
    nxt = track_clips[left_idx + 2] if left_idx + 2 < len(track_clips) else None

    track = project.track_by_id(left.track_id)
    media_end = float("inf")
    if track is not None and track.media is not None and track.media.duration_sec is not None:
        media_end = float(track.media.duration_sec)

    # Max grow left / shrink right (positive delta = join later): limited by
    # left room into media and right clip remaining duration (cannot roll past
    # the right clip's usable content).
    max_pos = min(
        media_end - left.source_end,
        right.source_end - right.source_start - _MIN_CLIP_SPAN_SEC,
    )
    if nxt is not None:
        max_pos = min(max_pos, float(nxt.source_start) - right.source_start)
    # Max shrink left / grow right (negative delta = join earlier): limited by
    # left clip remaining duration and how far right.source_start can move back
    # into unused source (cutaway / after previous clip).
    max_neg = min(
        left.source_end - left.source_start - _MIN_CLIP_SPAN_SEC,
        right.source_start - (float(prev.source_end) if prev is not None else 0.0),
    )
    max_pos = max(0.0, max_pos)
    max_neg = max(0.0, max_neg)
    delta = min(max(float(delta_sec), -max_neg), max_pos)
    if abs(delta) < 1e-12:
        return left, right

    left.source_end += delta
    right.source_start += delta
    right.timeline_start = left.timeline_end
    left.mute_regions = intersect_mute_regions(
        left.mute_regions, left.source_start, left.source_end
    )
    right.mute_regions = intersect_mute_regions(
        right.mute_regions, right.source_start, right.source_end
    )
    update_timeline_duration(project)
    return left, right


def pin_clip_source_id(project: EpisodeProject, clip: Clip) -> None:
    """Bind ``clip.source_id`` to the media currently on its track.

    Required before changing ``track_id`` so render keeps the originating file
    (``resolve_clip_audio_path`` falls back to destination ``track.media``).
    """
    if clip.source_id and any(s.id == clip.source_id for s in project.sources):
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
        raise ValueError("clips must be a non-empty list")
    seen: set[str] = set()
    parsed: list[tuple[Clip, float, str]] = []
    for raw in moves:
        cid = str(raw["clip_id"])
        if cid in seen:
            raise ValueError(f"duplicate clip_id: {cid!r}")
        seen.add(cid)
        clip = next((c for c in project.clips if c.id == cid), None)
        if clip is None:
            raise ValueError(f"unknown clip_id: {cid!r}")
        tl = float(raw["timeline_start"])
        if not math.isfinite(tl) or tl < 0:
            raise ValueError(f"timeline_start must be >= 0, got {tl!r}")
        tid = str(raw["track_id"])
        if project.track_by_id(tid) is None:
            raise ValueError(f"unknown track_id: {tid!r}")
        parsed.append((clip, tl, tid))
    for clip, tl, tid in parsed:
        if tid != clip.track_id:
            pin_clip_source_id(project, clip)
            if not clip.source_id:
                raise ValueError(
                    f"cannot move clip {clip.id!r} to another track without origin media"
                )
            clip.track_id = tid
        clip.timeline_start = tl
    update_timeline_duration(project)
    return [c for c, _, _ in parsed]
