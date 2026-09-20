from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from podcast_mcp.edits.clips_ops import (
    clips_for_track,
    new_clip_id,
    place_clips_at,
    set_track_clips,
    shift_clips_timeline,
    update_timeline_duration,
)
from podcast_mcp.edits.mute_regions import subtract_source_mute
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    ClipJoinMode,
    EditDecision,
    EpisodeProject,
)
from podcast_mcp.util.change_summary import change_summary


def _new_log_id() -> str:
    return f"alog_{uuid.uuid4().hex[:8]}"


def archive_decision(
    project: EpisodeProject,
    decision: EditDecision,
    *,
    operation: str,
    timeline_start: float | None = None,
    timeline_end: float | None = None,
    params: dict[str, Any] | None = None,
    track_ids: list[str] | None = None,
) -> AppliedEditRecord:
    ids = list(track_ids) if track_ids is not None else [decision.track_id]
    record = AppliedEditRecord(
        id=_new_log_id(),
        applied_at=datetime.now(UTC).isoformat(),
        operation=operation,
        decision_ids=[decision.id],
        track_ids=ids,
        source_start=decision.start,
        source_end=decision.end,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        reason=decision.reason,
        crossfade_ms=decision.crossfade_ms,
        boundary_mode=decision.boundary_mode,
        cut_confidence=decision.cut_confidence,
        params=params or {},
    )
    project.editorial.edit_log.append(record)
    return record


def archive_timeline_op(
    project: EpisodeProject,
    *,
    operation: str,
    track_ids: list[str],
    timeline_start: float | None = None,
    timeline_end: float | None = None,
    source_start: float | None = None,
    source_end: float | None = None,
    reason: str | None = None,
    params: dict[str, Any] | None = None,
) -> AppliedEditRecord:
    record = AppliedEditRecord(
        id=_new_log_id(),
        applied_at=datetime.now(UTC).isoformat(),
        operation=operation,
        track_ids=track_ids,
        source_start=source_start,
        source_end=source_end,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        reason=reason,
        params=params or {},
    )
    project.editorial.edit_log.append(record)
    return record


def list_applied_edits(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    timeline_start: float | None = None,
    timeline_end: float | None = None,
) -> list[AppliedEditRecord]:
    out: list[AppliedEditRecord] = []
    for record in project.editorial.edit_log:
        if track_id and track_id not in record.track_ids:
            continue
        if timeline_start is not None and timeline_end is not None:
            if record.timeline_start is None or record.timeline_end is None:
                continue
            if record.timeline_end <= timeline_start or record.timeline_start >= timeline_end:
                continue
        out.append(record)
    return out


def get_applied_edit(project: EpisodeProject, record_id: str) -> AppliedEditRecord:
    for record in project.editorial.edit_log:
        if record.id == record_id:
            return record
    raise KeyError(f"applied edit not found: {record_id}")


def _per_track_source_pairs(record: AppliedEditRecord) -> dict[str, tuple[float, float]]:
    per_track_raw = (record.params or {}).get("per_track_source") or {}
    per_track: dict[str, tuple[float, float]] = {}
    for tid, pair in per_track_raw.items():
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            per_track[str(tid)] = (float(pair[0]), float(pair[1]))
    return per_track


def _revert_mute_archive(project: EpisodeProject, record: AppliedEditRecord) -> dict[str, Any]:
    """Subtract mute spans in place; never ripple or re-insert clips."""
    if record.source_start is None or record.source_end is None or not record.track_ids:
        raise ValueError("applied mute lacks source clocks for restore; use History undo instead")
    if record.source_end <= record.source_start:
        raise ValueError("applied edit has invalid source range")
    per_track = _per_track_source_pairs(record)
    restore_tracks = list(record.track_ids)
    for tid in restore_tracks:
        if tid in per_track:
            s0, s1 = per_track[tid]
        else:
            s0 = float(record.source_start)
            s1 = float(record.source_end)
        if s1 <= s0:
            continue
        for clip in clips_for_track(project, tid):
            subtract_source_mute(clip, s0, s1)
    project.editorial.edit_log = [r for r in project.editorial.edit_log if r.id != record.id]
    rebuild_combined(project)
    update_timeline_duration(project)
    return change_summary(
        project,
        operation="revert_applied_edit",
        affected_tracks=restore_tracks,
        id=record.id,
        duration_sec=0.0,
        track_ids=restore_tracks,
    )


def revert_applied_edit(project: EpisodeProject, record_id: str) -> dict[str, Any]:
    """Re-insert clip material for one AppliedEditRecord and remove it from the log.

    Mute archives (``params.mute``) subtract intersecting ``Clip.mute_regions``
    and never shift peers or re-insert source media.

    Cross-track ripples must reopen the same timeline hole on **all** dialogue
    tracks (even legacy archives that only listed one ``track_id``); otherwise
    later clips stay skewed forever. Per-track source ranges may be supplied in
    ``params['per_track_source']`` as ``{track_id: [start, end]}``.
    """
    from podcast_mcp.util.tracks import dialogue_track_ids

    record = get_applied_edit(project, record_id)
    if (record.params or {}).get("mute"):
        return _revert_mute_archive(project, record)
    if (
        record.timeline_start is None
        or record.timeline_end is None
        or record.source_start is None
        or record.source_end is None
        or not record.track_ids
    ):
        raise ValueError(
            "applied edit lacks source/timeline clocks for restore; use History undo instead"
        )
    if record.source_end <= record.source_start:
        raise ValueError("applied edit has invalid source range")

    insert_at = float(record.timeline_start)
    duration = float(record.timeline_end) - float(record.timeline_start)
    if duration <= 0:
        duration = float(record.source_end) - float(record.source_start)

    per_track = _per_track_source_pairs(record)

    # Always realign every dialogue track; fill media when we know source clocks.
    restore_tracks = dialogue_track_ids(project) or list(record.track_ids)
    for tid in restore_tracks:
        clips = clips_for_track(project, tid)
        shift_clips_timeline(clips, insert_at, duration)
        if tid in per_track:
            s0, s1 = per_track[tid]
        elif tid in record.track_ids:
            s0 = float(record.source_start)
            s1 = float(record.source_end)
        else:
            # Keep sync with a silent hole (no foreign-source insert).
            set_track_clips(project, tid, clips)
            continue
        if s1 <= s0:
            set_track_clips(project, tid, clips)
            continue
        restored = Clip(
            id=new_clip_id(),
            track_id=tid,
            source_start=s0,
            source_end=s1,
            timeline_start=0.0,
            fade_in_ms=record.crossfade_ms or 0,
            fade_out_ms=record.crossfade_ms or 0,
            join_in_mode=ClipJoinMode.FADE,
        )
        merged = place_clips_at(clips, [restored], insert_at)
        set_track_clips(project, tid, merged)

    project.editorial.edit_log = [r for r in project.editorial.edit_log if r.id != record_id]
    rebuild_combined(project)
    update_timeline_duration(project)
    return change_summary(
        project,
        operation="revert_applied_edit",
        affected_tracks=list(restore_tracks),
        id=record_id,
        duration_sec=duration,
        track_ids=list(restore_tracks),
    )
