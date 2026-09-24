"""Cause journal for stem staleness - diagnostic regions, not partial re-render."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from podcast_mcp.models import AppliedEditRecord, EpisodeProject, RenderInvalidation
from podcast_mcp.util.tracks import dialogue_track_ids

VALID_REASONS = frozenset({"cut", "clip", "envelope", "fx", "gain", "mute", "other"})

_CUT_OPS = frozenset(
    {
        "approve_edits",
        "apply_auto_edits",
        "ripple_delete",
        "ripple_delete_text",
        "punch_delete",
        "strip_silence",
        "shorten_word_gaps",
        "cut_text",
        "apply_edit_plan",
    }
)
_FX_OPS = frozenset(
    {
        "set_effect_bypass",
        "set_processing_chain",
        "apply_cleanup",
        "apply_preset",
    }
)
_GAIN_OPS = frozenset({"set_gain", "balance_levels", "set_track_gain", "set_track_fader"})
_MUTE_OPS = frozenset({"set_mute", "mute_bleed", "set_track_mute"})
_ENVELOPE_OPS = frozenset({"set_envelope"})
_CLIP_OPS = frozenset(
    {
        "set_clip_fade",
        "set_clip_join_mode",
        "fade_joins",
        "crossfade_joins",
        "split_at_time",
        "move_segment",
        "move_by_text",
        "insert_gap",
        "move_clips",
    }
)


def _new_id() -> str:
    return f"inv_{uuid.uuid4().hex[:10]}"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def reason_for_operation(operation: str | None) -> str:
    if not operation:
        return "other"
    if operation in _CUT_OPS:
        return "cut"
    if operation in _FX_OPS:
        return "fx"
    if operation in _GAIN_OPS:
        return "gain"
    if operation in _MUTE_OPS:
        return "mute"
    if operation in _ENVELOPE_OPS:
        return "envelope"
    if operation in _CLIP_OPS:
        return "clip"
    return "other"


def record_invalidation(
    project: EpisodeProject,
    *,
    track_ids: list[str],
    reason: str = "other",
    timeline_start: float | None = None,
    timeline_end: float | None = None,
) -> RenderInvalidation:
    ids = [t for t in track_ids if t]
    if not ids:
        ids = list(dialogue_track_ids(project))
    reason_norm = reason if reason in VALID_REASONS else "other"
    inv = RenderInvalidation(
        id=_new_id(),
        track_ids=ids,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        reason=reason_norm,
        at=_now(),
    )
    project.render.invalidations.append(inv)
    return inv


def clear_invalidations_for_tracks(project: EpisodeProject, track_ids: Iterable[str]) -> int:
    drop = set(track_ids)
    if not drop:
        return 0
    before = len(project.render.invalidations)
    kept: list[RenderInvalidation] = []
    for inv in project.render.invalidations:
        remaining = [t for t in inv.track_ids if t not in drop]
        if not remaining:
            continue
        if len(remaining) != len(inv.track_ids):
            inv = inv.model_copy(update={"track_ids": remaining})
        kept.append(inv)
    project.render.invalidations = kept
    return before - len(kept)


def replace_with_whole_track(
    project: EpisodeProject,
    track_ids: Iterable[str],
    *,
    reason: str = "other",
) -> None:
    """Undo/redo: stems wiped; replace causes with whole-track markers."""
    ids = [t for t in track_ids if t]
    if not ids:
        return
    clear_invalidations_for_tracks(project, ids)
    record_invalidation(project, track_ids=ids, reason=reason)


def record_after_audio_mutation(
    project: EpisodeProject,
    *,
    changed_track_ids: list[str],
    operation: str | None,
    new_edit_log: list[AppliedEditRecord],
) -> list[RenderInvalidation]:
    """Append diagnostic invalidations after an audio-affecting mutate."""
    if not changed_track_ids:
        return []
    reason = reason_for_operation(operation)
    created: list[RenderInvalidation] = []
    changed = set(changed_track_ids)

    covered: set[str] = set()
    for rec in new_edit_log:
        tids = [t for t in rec.track_ids if t in changed]
        if not tids:
            continue
        if rec.timeline_start is None or rec.timeline_end is None:
            continue
        if float(rec.timeline_end) < float(rec.timeline_start):
            continue
        rec_reason = "mute" if (rec.params or {}).get("mute") else reason
        created.append(
            record_invalidation(
                project,
                track_ids=tids,
                reason="cut" if rec_reason == "other" else rec_reason,
                timeline_start=float(rec.timeline_start),
                timeline_end=float(rec.timeline_end),
            )
        )
        covered.update(tids)

    # Tracks touched by the mutation but not covered by a regional edit-log
    # row still need a whole-track journal entry (e.g. FX on a sibling stem).
    leftover = [t for t in changed_track_ids if t not in covered]
    if leftover:
        created.append(
            record_invalidation(
                project,
                track_ids=leftover,
                reason=reason,
                timeline_start=None,
                timeline_end=None,
            )
        )
    return created


def invalidations_as_dicts(project: EpisodeProject) -> list[dict]:
    return [inv.model_dump() for inv in project.render.invalidations]
