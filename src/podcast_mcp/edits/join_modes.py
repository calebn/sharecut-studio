"""Clip join mode helpers: fade (butt splice) vs crossfade (overlap)."""

from __future__ import annotations

import logging
import math

from podcast_mcp.config.defaults import (
    EffectiveConfig,
    bounded_float,
    bundled_defaults,
    join_micro_fade_ms,
)
from podcast_mcp.edits.cut_quality import recommend_cut_fade_ms
from podcast_mcp.engines.clips_ops import (
    abutting_pairs,
    clips_for_track,
    join_render_fields,
    neighbour_clips,
    previous_clip,
)
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, TrackRole
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import dialogue_track_ids, resolve_track

JOIN_FADE_DEFAULT_RANGE_MS = (0, 200)

log = logging.getLogger(__name__)


def _checked_join_fade_ms(value: object) -> int:
    lo, hi = JOIN_FADE_DEFAULT_RANGE_MS
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise CodedValueError("join fade length must be a number", code="out_of_range")
    try:
        ms = int(value)
    except ValueError:
        raise CodedValueError("join fade length must be a number", code="out_of_range") from None
    if not lo <= ms <= hi:
        raise CodedValueError(
            f"join fade length must be between {lo} and {hi} ms. Pass a value in that range.",
            code="out_of_range",
        )
    return ms


def join_fade_max_ms(defaults: EffectiveConfig) -> int:
    bundled = int(bundled_defaults()["render"]["join_fade_max_ms"])
    configured = defaults.get("render", {}).get("join_fade_max_ms")
    if configured is None:
        return bundled
    lo, hi = JOIN_FADE_DEFAULT_RANGE_MS
    ms = (
        bundled if isinstance(configured, bool) else int(bounded_float(configured, bundled, lo, hi))
    )
    if ms != configured or isinstance(configured, bool):
        log.warning(
            "join_fade_max_ms_out_of_range: render.join_fade_max_ms=%r is not a whole number "
            "of ms between %d and %d; using %d",
            configured,
            lo,
            hi,
            ms,
        )
    return ms


def auto_join_fade_cap_ms(project: EpisodeProject, defaults: EffectiveConfig) -> int:
    """Longest fade (ms) the automatic join writers add: the episode's Default join fade
    length, else ``render.join_fade_max_ms`` from the config, else the bundled default.
    """
    own = project.timeline.join_fade_max_ms
    return join_fade_max_ms(defaults) if own is None else _checked_join_fade_ms(own)


def cap_fade_ms(
    project: EpisodeProject,
    track_id: str,
    fade_ms: int,
    defaults: EffectiveConfig,
) -> int:
    """Cap an automatically written dialogue fade at the Default join fade length.

    Manual fades (``clamp_clip_fades``) never pass through here; other roles are uncapped.
    """
    fade = max(0, fade_ms)
    track = project.track_by_id(track_id)
    if track is None or track.role != TrackRole.DIALOGUE:
        return fade
    return min(fade, auto_join_fade_cap_ms(project, defaults))


def set_join_fade_default(
    project: EpisodeProject, ms: int | None, *, defaults: EffectiveConfig
) -> dict:
    """Store the episode's Default join fade length; ``None`` returns to the app default.

    Rewrites no existing fade: only the automatic join writers read it afterwards.
    """
    project.timeline.join_fade_max_ms = None if ms is None else _checked_join_fade_ms(ms)
    summary = change_summary(project, operation="set_join_fade_default", affected_tracks=[])
    summary["stored_ms"] = project.timeline.join_fade_max_ms
    summary["join_fade_default_ms"] = auto_join_fade_cap_ms(project, defaults)
    return summary


def clamp_clip_fades(clip: Clip, fade_in_ms: int, fade_out_ms: int) -> tuple[int, int]:
    """Edge fades a manual edit may give *clip*: each fits in the clip and the fade-out in
    what the fade-in leaves, so the two never overlap. No other cap applies.

    The DAW mirrors this rule in ``gui/web/src/edit/fadeLimits.ts`` (``clampClipFades``).
    """
    clip_ms = max(0, math.floor((clip.source_end - clip.source_start) * 1000))
    fade_in = min(max(0, fade_in_ms), clip_ms)
    fade_out = min(max(0, fade_out_ms), clip_ms - fade_in)
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
        raise CodedValueError(f"unknown clip_id: {clip_id!r}", code="clip_not_found")
    join_mode = mode if isinstance(mode, ClipJoinMode) else ClipJoinMode(mode)
    clip.join_in_mode = join_mode
    prev = previous_clip(clips_for_track(project, clip.track_id), clip.id)
    summary = change_summary(
        project, operation="set_clip_join_mode", affected_tracks=[clip.track_id]
    )
    summary.update(join_render_fields(prev, clip, project))
    return summary


def default_join_length_ms(mode: ClipJoinMode, defaults: EffectiveConfig) -> int:
    """Seed length (ms) for a join in *mode*: crossfade overlap or the declick micro-fade."""
    if mode == ClipJoinMode.CROSSFADE:
        return int(defaults.get("tighten", {}).get("crossfade_ms", 25))
    if mode == ClipJoinMode.FADE:
        return join_micro_fade_ms(defaults)
    return 0


def set_clip_join(
    project: EpisodeProject,
    left_clip_id: str,
    right_clip_id: str,
    mode: ClipJoinMode | str,
    *,
    length_ms: int | None = None,
    defaults: EffectiveConfig,
) -> dict:
    """Set the join between two neighbouring clips: mode plus the fades render reads.

    ``crossfade`` sets ``left.fade_out_ms`` and ``right.fade_in_ms`` to ``length_ms``
    (default ``tighten.crossfade_ms``; ``0`` is rejected). ``cut`` zeroes both fades
    (a later fade/crossfade reseeds defaults; undo restores them).
    ``fade`` sets both to ``length_ms``; without one it keeps the current fades, seeding
    ``inaudible_cuts.micro_fade_ms`` when both are 0. This is a manual edit: fades go through
    ``clamp_clip_fades`` like ``set_clip_fade`` (bounded by the clips, not by the Default join
    fade length). Non-abutting neighbours are allowed; the result reports
    ``crossfade_blocked``. The DAW's join Length slider max mirrors this clamp order
    (``gui/web/src/edit/fadeLimits.ts`` ``joinLengthMaxMs``); ``contracts/join-length-limits.json``
    pins both.
    """
    left, right, _, _ = neighbour_clips(project, left_clip_id, right_clip_id)
    join_mode = mode if isinstance(mode, ClipJoinMode) else ClipJoinMode(mode)
    if length_ms is not None and length_ms < 0:
        raise CodedValueError("length_ms must be >= 0. Pass 0 or more.", code="out_of_range")
    if join_mode == ClipJoinMode.CROSSFADE:
        ms = length_ms if length_ms is not None else default_join_length_ms(join_mode, defaults)
        if ms <= 0:
            raise CodedValueError(
                "crossfade length_ms must be > 0. Pass more than 0.", code="out_of_range"
            )
        out_ms = in_ms = ms
    elif join_mode == ClipJoinMode.CUT:
        out_ms = in_ms = 0
    elif length_ms is not None:
        out_ms = in_ms = length_ms
    elif left.fade_out_ms == 0 and right.fade_in_ms == 0:
        out_ms = in_ms = default_join_length_ms(join_mode, defaults)
    else:
        out_ms, in_ms = left.fade_out_ms, right.fade_in_ms
    right.join_in_mode = join_mode
    left.fade_in_ms, left.fade_out_ms = clamp_clip_fades(left, left.fade_in_ms, out_ms)
    right.fade_in_ms, right.fade_out_ms = clamp_clip_fades(right, in_ms, right.fade_out_ms)
    fields = join_render_fields(left, right, project)
    blocked = fields["join_crossfade_blocked"]
    summary = change_summary(project, operation="set_clip_join", affected_tracks=[left.track_id])
    summary.update(
        {
            "left_clip_id": left.id,
            "right_clip_id": right.id,
            "join_in_mode": join_mode.value,
            "left_fade_out_ms": left.fade_out_ms,
            "right_fade_in_ms": right.fade_in_ms,
            "crossfade_ms": fields["join_crossfade_ms"],
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
    defaults: EffectiveConfig,
    dry_run: bool = False,
) -> dict:
    """Set abutting joins to fade mode with declick micro-fades (no overlap).

    An automatic writer: fades are capped at the Default join fade length and never shrink an
    existing longer fade. ``fade_ms`` in the result is the length applied after the cap
    (``requested_fade_ms`` is what was asked for, ``cap_ms`` the cap); ``kept_longer_joins``
    counts joins where a longer existing fade was left as it is.
    """
    join_count = 0
    track_ids = _target_track_ids(project, track_id=track_id, speaker=speaker)
    applied_ms: list[int] = []
    kept_longer = 0
    for tid in track_ids:
        clips = clips_for_track(project, tid)
        for left, right in abutting_pairs(clips):
            join_count += 1
            if fade_ms is not None:
                ms = cap_fade_ms(project, tid, fade_ms, defaults)
            elif dry_run:
                continue
            else:
                ms = cap_fade_ms(
                    project,
                    tid,
                    recommend_cut_fade_ms(
                        project,
                        tid,
                        left.source_end,
                        right.source_start,
                        cut_kind="filler",
                        defaults=defaults,
                    ),
                    defaults,
                )
            applied_ms.append(ms)
            kept_longer += left.fade_out_ms > ms or right.fade_in_ms > ms
            if dry_run:
                continue
            right.join_in_mode = ClipJoinMode.FADE
            left.fade_out_ms = max(left.fade_out_ms, ms)
            right.fade_in_ms = max(right.fade_in_ms, ms)
    cap_ms = auto_join_fade_cap_ms(project, defaults)
    if applied_ms:
        shown_ms: int | None = max(applied_ms)
    else:
        shown_ms = None if fade_ms is None else min(max(0, fade_ms), cap_ms)
    return {
        "operation": "fade_joins",
        "join_count": join_count,
        "fade_ms": shown_ms,
        "requested_fade_ms": fade_ms,
        "cap_ms": cap_ms,
        "kept_longer_joins": kept_longer,
        "dry_run": dry_run,
        "affected_tracks": track_ids,
    }


def crossfade_joins(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    speaker: str | None = None,
    fade_ms: int | None = None,
    defaults: EffectiveConfig,
    dry_run: bool = False,
) -> dict:
    """Set abutting joins to crossfade mode with overlapping blend fades."""
    ms = (
        fade_ms if fade_ms is not None else default_join_length_ms(ClipJoinMode.CROSSFADE, defaults)
    )
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
