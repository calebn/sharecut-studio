"""Clip join mode helpers: fade (butt splice) vs crossfade (overlap)."""

from __future__ import annotations

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.clips_ops import JOIN_GAP_TOLERANCE_SEC, clips_for_track
from podcast_mcp.edits.cut_quality import recommend_cut_fade_ms
from podcast_mcp.models import ClipJoinMode, EpisodeProject, TrackRole
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.tracks import dialogue_track_ids, resolve_track


def join_fade_max_ms(defaults: dict | None = None) -> int:
    cfg = defaults or load_defaults()
    return int(cfg.get("render", {}).get("join_fade_max_ms", 40))


def cap_fade_ms(
    project: EpisodeProject,
    track_id: str,
    fade_ms: int,
    defaults: dict | None = None,
) -> int:
    """Cap dialogue fades at render.join_fade_max_ms; leave other roles uncapped."""
    cfg = defaults or load_defaults()
    track = project.track_by_id(track_id)
    if track and track.role == TrackRole.DIALOGUE:
        return min(max(0, fade_ms), join_fade_max_ms(cfg))
    return max(0, fade_ms)


def set_clip_join_mode(
    project: EpisodeProject,
    clip_id: str,
    mode: ClipJoinMode | str,
) -> dict:
    """Set join_in_mode on one clip (incoming join at its timeline_start)."""
    clip = next((c for c in project.clips if c.id == clip_id), None)
    if not clip:
        raise ValueError(f"unknown clip_id: {clip_id!r}")
    join_mode = mode if isinstance(mode, ClipJoinMode) else ClipJoinMode(mode)
    clip.join_in_mode = join_mode
    return change_summary(project, operation="set_clip_join_mode", affected_tracks=[clip.track_id])


def _abutting_pairs(clips: list) -> list[tuple]:
    pairs: list[tuple] = []
    for i in range(len(clips) - 1):
        left, right = clips[i], clips[i + 1]
        if right.timeline_start - left.timeline_end <= JOIN_GAP_TOLERANCE_SEC:
            pairs.append((left, right))
    return pairs


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
        for left, right in _abutting_pairs(clips):
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
    default_ms = int(cfg.get("tighten", {}).get("crossfade_ms", 25))
    ms = fade_ms if fade_ms is not None else default_ms
    join_count = 0
    for tid in _target_track_ids(project, track_id=track_id, speaker=speaker):
        clips = clips_for_track(project, tid)
        for left, right in _abutting_pairs(clips):
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
