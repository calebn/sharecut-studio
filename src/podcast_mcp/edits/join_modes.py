"""Clip join mode helpers: fade (butt splice) vs crossfade (overlap)."""

from __future__ import annotations

import math

from podcast_mcp.config import join_micro_fade_ms, load_defaults
from podcast_mcp.edits.clips_ops import (
    abutting_pairs,
    clip_index,
    clips_for_track,
    crossfade_block_reason,
    crossfade_ms_at_join,
    join_render_fields,
    neighbour_clips,
)
from podcast_mcp.edits.cut_quality import recommend_cut_fade_ms
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, Track, TrackRole
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.tracks import dialogue_track_ids, resolve_track


def join_fade_max_ms(defaults: dict | None = None) -> int:
    cfg = defaults or load_defaults()
    return int(cfg.get("render", {}).get("join_fade_max_ms", 40))


def track_fade_max_ms(track: Track | None, defaults: dict | None = None) -> int | None:
    """Longest edge fade (ms) a clip on *track* may take; ``None`` when uncapped.

    Dialogue fades cap at ``render.join_fade_max_ms``; other roles are uncapped.
    The project view (``TrackView.fade_max_ms``), ``cap_fade_ms`` (used by the batch fade
    writers) and ``clamp_clip_fades`` (used by ``set_clip_fade``) resolve the cap here; keep
    any future per-episode override inside this function so they cannot diverge. Only
    ``clamp_clip_fades`` also bounds a fade by the clip length and the other edge's fade.
    """
    if track is None or track.role != TrackRole.DIALOGUE:
        return None
    return join_fade_max_ms(defaults)


def cap_fade_ms(
    project: EpisodeProject,
    track_id: str,
    fade_ms: int,
    defaults: dict | None = None,
) -> int:
    """Cap dialogue fades at render.join_fade_max_ms; leave other roles uncapped."""
    cap = track_fade_max_ms(project.track_by_id(track_id), defaults)
    fade = max(0, fade_ms)
    return fade if cap is None else min(fade, cap)


def clamp_clip_fades(
    project: EpisodeProject,
    clip: Clip,
    fade_in_ms: int,
    fade_out_ms: int,
    defaults: dict | None = None,
) -> tuple[int, int]:
    """Edge fades *clip* may take: each capped for its track and bounded by the clip
    length, and fade-out bounded by what fade-in leaves so the two never overlap.

    The DAW mirrors this rule in ``gui/web/src/edit/fadeLimits.ts`` (``clampClipFades``).
    """
    cfg = defaults or load_defaults()
    clip_ms = max(0, math.floor((clip.source_end - clip.source_start) * 1000))
    fade_in = min(cap_fade_ms(project, clip.track_id, fade_in_ms, cfg), clip_ms)
    fade_out = min(cap_fade_ms(project, clip.track_id, fade_out_ms, cfg), clip_ms - fade_in)
    return fade_in, fade_out


def set_clip_join_mode(
    project: EpisodeProject,
    clip_id: str,
    mode: ClipJoinMode | str,
) -> dict:
    """Set join_in_mode on one clip (incoming join at its timeline_start); mode only.

    Fades are left as they are, so a crossfade with no fades renders as a plain join.
    The result carries ``join_render_fields`` (``join_crossfade_blocked`` says why);
    ``set_clip_join`` sets the mode and the fades together.
    """
    clip = next((c for c in project.clips if c.id == clip_id), None)
    if not clip:
        raise ValueError(f"unknown clip_id: {clip_id!r}")
    join_mode = mode if isinstance(mode, ClipJoinMode) else ClipJoinMode(mode)
    clip.join_in_mode = join_mode
    track_clips = clips_for_track(project, clip.track_id)
    idx = clip_index(track_clips, clip.id)
    prev = track_clips[idx - 1] if idx > 0 else None
    summary = change_summary(
        project, operation="set_clip_join_mode", affected_tracks=[clip.track_id]
    )
    summary.update(join_render_fields(prev, clip))
    return summary


def default_join_length_ms(mode: ClipJoinMode, defaults: dict | None = None) -> int:
    """Seed length (ms) for a join in *mode*: crossfade overlap or the declick micro-fade."""
    cfg = defaults or load_defaults()
    if mode == ClipJoinMode.CROSSFADE:
        return int(cfg.get("tighten", {}).get("crossfade_ms", 25))
    if mode == ClipJoinMode.FADE:
        return join_micro_fade_ms(cfg)
    return 0


def set_clip_join(
    project: EpisodeProject,
    left_clip_id: str,
    right_clip_id: str,
    mode: ClipJoinMode | str,
    *,
    length_ms: int | None = None,
    defaults: dict | None = None,
) -> dict:
    """Set the join between two neighbouring clips: mode plus the fades render reads.

    ``crossfade`` sets ``left.fade_out_ms`` and ``right.fade_in_ms`` to ``length_ms``
    (default ``tighten.crossfade_ms``; ``0`` is rejected). ``cut`` zeroes both fades (a later fade/crossfade reseeds defaults; undo restores them).
    ``fade`` sets both to ``length_ms``; without one it keeps the current fades, seeding
    ``inaudible_cuts.micro_fade_ms`` when both are 0. Fades go through ``clamp_clip_fades``
    like ``set_clip_fade``. Non-abutting neighbours are allowed; the result reports
    ``crossfade_blocked``.
    """
    cfg = defaults or load_defaults()
    left, right, _, _ = neighbour_clips(project, left_clip_id, right_clip_id)
    join_mode = mode if isinstance(mode, ClipJoinMode) else ClipJoinMode(mode)
    if length_ms is not None and length_ms < 0:
        raise ValueError("length_ms must be >= 0")
    if join_mode == ClipJoinMode.CROSSFADE:
        ms = length_ms if length_ms is not None else default_join_length_ms(join_mode, cfg)
        if ms <= 0:
            raise ValueError("crossfade length_ms must be > 0")
        out_ms = in_ms = ms
    elif join_mode == ClipJoinMode.CUT:
        out_ms = in_ms = 0
    elif length_ms is not None:
        out_ms = in_ms = length_ms
    elif left.fade_out_ms == 0 and right.fade_in_ms == 0:
        out_ms = in_ms = default_join_length_ms(join_mode, cfg)
    else:
        out_ms, in_ms = left.fade_out_ms, right.fade_in_ms
    right.join_in_mode = join_mode
    left.fade_in_ms, left.fade_out_ms = clamp_clip_fades(
        project, left, left.fade_in_ms, out_ms, cfg
    )
    right.fade_in_ms, right.fade_out_ms = clamp_clip_fades(
        project, right, in_ms, right.fade_out_ms, cfg
    )
    blocked = crossfade_block_reason(left, right) if join_mode == ClipJoinMode.CROSSFADE else None
    summary = change_summary(project, operation="set_clip_join", affected_tracks=[left.track_id])
    summary.update(
        {
            "left_clip_id": left.id,
            "right_clip_id": right.id,
            "join_in_mode": join_mode.value,
            "left_fade_out_ms": left.fade_out_ms,
            "right_fade_in_ms": right.fade_in_ms,
            "crossfade_ms": crossfade_ms_at_join(left, right),
            "crossfade_blocked": blocked,
        }
    )
    return summary


def _target_track_ids(
    project: EpisodeProject,
    *,
    track_id: str | None,
    speaker: str | None,
) -> list[str]:
    if track_id or speaker:
        return [resolve_track(project, track_id=track_id, speaker=speaker)]
    return dialogue_track_ids(project)


def fade_joins(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    speaker: str | None = None,
    fade_ms: int | None = None,
    defaults: dict | None = None,
    dry_run: bool = False,
) -> dict:
    """Set abutting joins to fade mode with declick micro-fades (no overlap)."""
    cfg = defaults or load_defaults()
    join_count = 0
    for tid in _target_track_ids(project, track_id=track_id, speaker=speaker):
        clips = clips_for_track(project, tid)
        for left, right in abutting_pairs(clips):
            join_count += 1
            if dry_run:
                continue
            right.join_in_mode = ClipJoinMode.FADE
            if fade_ms is not None:
                ms = cap_fade_ms(project, tid, fade_ms, cfg)
                left.fade_out_ms = max(left.fade_out_ms, ms)
                right.fade_in_ms = max(right.fade_in_ms, ms)
            else:
                ms = recommend_cut_fade_ms(
                    project,
                    tid,
                    left.source_end,
                    right.source_start,
                    cut_kind="filler",
                    defaults=cfg,
                )
                ms = cap_fade_ms(project, tid, ms, cfg)
                left.fade_out_ms = max(left.fade_out_ms, ms)
                right.fade_in_ms = max(right.fade_in_ms, ms)
    return {
        "operation": "fade_joins",
        "join_count": join_count,
        "fade_ms": fade_ms,
        "dry_run": dry_run,
        "affected_tracks": _target_track_ids(project, track_id=track_id, speaker=speaker),
    }


def crossfade_joins(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    speaker: str | None = None,
    fade_ms: int | None = None,
    defaults: dict | None = None,
    dry_run: bool = False,
) -> dict:
    """Set abutting joins to crossfade mode with overlapping blend fades."""
    cfg = defaults or load_defaults()
    ms = fade_ms if fade_ms is not None else default_join_length_ms(ClipJoinMode.CROSSFADE, cfg)
    join_count = 0
    for tid in _target_track_ids(project, track_id=track_id, speaker=speaker):
        clips = clips_for_track(project, tid)
        for left, right in abutting_pairs(clips):
            join_count += 1
            if dry_run:
                continue
            right.join_in_mode = ClipJoinMode.CROSSFADE
            left.fade_out_ms = max(left.fade_out_ms, ms)
            right.fade_in_ms = max(right.fade_in_ms, ms)
    return {
        "operation": "crossfade_joins",
        "join_count": join_count,
        "fade_ms": ms,
        "dry_run": dry_run,
        "affected_tracks": _target_track_ids(project, track_id=track_id, speaker=speaker),
    }
