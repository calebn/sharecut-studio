from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from podcast_mcp.edits.clips_ops import (
    clips_for_track,
    update_timeline_duration,
)
from podcast_mcp.edits.mute_regions import subtract_source_mute
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.engines.session_timeline import seam_source_clocks_over_clips
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    EditDecision,
    EpisodeProject,
)
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.coded_error import CodedError


class LocalRestoreRequiresHistory(CodedError, ValueError):
    code = "local_restore_requires_history"

    def __init__(self, record_id: str) -> None:
        self.record_id = record_id
        super().__init__(
            "This edit cannot be restored individually. "
            "Use History Undo to restore the whole action. "
            "History Undo also undoes the other edits in that action. "
            "You may need to undo later actions first."
        )


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
        source_start=(params or {}).get("source_start", decision.start)
        if decision.exact_range is None
        else None,
        source_end=(params or {}).get("source_end", decision.end)
        if decision.exact_range is None
        else None,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        reason=decision.reason,
        crossfade_ms=(params or {}).get("crossfade_ms", decision.crossfade_ms),
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


def seam_source_by_track(
    clips_by_track: Mapping[str, Sequence[Clip]],
    timeline_start: float,
    timeline_end: float,
) -> dict[str, list[float]]:
    """``params['per_track_source']``: each track's source clocks on either side of a cut.

    Read from the **pre-edit** clips in timeline order (see
    :func:`seam_source_clocks_over_clips`), so a span crossing a moved clip still
    records the joins the cut makes. The GUI projects applied ticks through the
    current clips from these clocks (#527). MUTE Restore also uses the source spans.
    These clocks do not identify removed clip material for individual Restore.
    Tracks with no material in the span are omitted.
    """
    out: dict[str, list[float]] = {}
    for tid, clips in clips_by_track.items():
        pair = seam_source_clocks_over_clips(clips, timeline_start, timeline_end)
        if pair is not None:
            out[str(tid)] = [float(pair[0]), float(pair[1])]
    return out


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
    assert record.source_start is not None and record.source_end is not None
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


def require_applied_edit_restore(project: EpisodeProject, record_id: str) -> AppliedEditRecord:
    """Refuse unsupported local Restore before the service records history."""
    record = get_applied_edit(project, record_id)
    if (
        record.params.get("mute") is not True
        or "exact_range" in record.params
        or record.source_start is None
        or record.source_end is None
        or not record.track_ids
        or record.source_end <= record.source_start
    ):
        raise LocalRestoreRequiresHistory(record.id)
    return record


def revert_applied_edit(project: EpisodeProject, record_id: str) -> dict[str, Any]:
    """Restore a source MUTE archive. Removed clips require whole-action History Undo."""
    record = require_applied_edit_restore(project, record_id)
    return _revert_mute_archive(project, record)
