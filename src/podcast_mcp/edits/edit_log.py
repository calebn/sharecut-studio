from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.clips_ops import (
    clips_for_track,
    update_timeline_duration,
)
from podcast_mcp.engines.mute_regions import mute_regions_overlapping, subtract_source_mute
from podcast_mcp.engines.session_timeline import seam_source_clocks_over_clips
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    AppliedEditInverse,
    AppliedEditRecord,
    Clip,
    EditDecision,
    EpisodeProject,
    UnmuteSource,
    UnmuteSpan,
)
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.intervals import subtract_intervals

LOCAL_RESTORE_REQUIRES_HISTORY = "local_restore_requires_history"
LOCAL_RESTORE_MESSAGE = (
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
    inverse: AppliedEditInverse | None = None,
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
        inverse=inverse,
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
    current clips from these clocks (#527). They are display data and do not
    identify removed clip material.
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


class RestoreConflict(BaseModel):
    code: str
    record_id: str
    message: str
    track_id: str | None = None
    blocked_by: list[str] = Field(default_factory=list)


class RestoreState(BaseModel):
    state: Literal["ready", "blocked", "history_only"]
    code: str | None = None
    message: str | None = None
    blocked_by: list[str] = Field(default_factory=list)


class RestoreResult(BaseModel):
    status: Literal["restored", "planned", "conflict"]
    conflicts: list[RestoreConflict] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class RestorePlan:
    record_id: str
    track_ids: tuple[str, ...]


@dataclass(frozen=True)
class _Restorer:
    plan: Callable[[EpisodeProject, AppliedEditRecord, Any, frozenset[str]], RestoreConflict | None]
    apply: Callable[[EpisodeProject, Any, Sequence[AppliedEditRecord]], None]


def _unmute_spans(record: AppliedEditRecord) -> list[UnmuteSpan]:
    return record.inverse.spans if isinstance(record.inverse, UnmuteSource) else []


def _span_is_muted(project: EpisodeProject, span: UnmuteSpan) -> bool:
    return any(
        clip.source_start < span.end
        and clip.source_end > span.start
        and mute_regions_overlapping(clip.mute_regions, span.start, span.end)
        for clip in clips_for_track(project, span.track_id)
    )


def _plan_unmute(
    project: EpisodeProject, record: AppliedEditRecord, inverse: UnmuteSource, batch: frozenset[str]
) -> RestoreConflict | None:
    for span in inverse.spans:
        if project.track_by_id(span.track_id) is None:
            return RestoreConflict(
                code="track_missing",
                record_id=record.id,
                track_id=span.track_id,
                message=f"Track {span.track_id} is no longer in the project.",
            )
    log = project.editorial.edit_log
    later = log[next(i for i, r in enumerate(log) if r.id == record.id) + 1 :]
    blocked_by = [
        r.id
        for r in later
        if r.id not in batch
        and any(
            m.track_id == s.track_id and m.start < s.end and m.end > s.start
            for m in _unmute_spans(r)
            for s in inverse.spans
        )
    ]
    if blocked_by:
        return RestoreConflict(
            code="overlapped_by_later",
            record_id=record.id,
            track_id=inverse.spans[0].track_id,
            blocked_by=blocked_by,
            message=(
                "A later edit mutes some of the same audio. "
                f"Restore {', '.join(blocked_by)} first, or restore them together."
            ),
        )
    if not any(_span_is_muted(project, s) for s in inverse.spans):
        return RestoreConflict(
            code="span_not_present",
            record_id=record.id,
            track_id=inverse.spans[0].track_id,
            message="The audio this edit muted is no longer in the project.",
        )
    return None


def _apply_unmute(
    project: EpisodeProject, inverse: UnmuteSource, kept: Sequence[AppliedEditRecord]
) -> None:
    """Subtract the spans the record wrote, except what a record that stays still claims."""
    for span in inverse.spans:
        claimed = [
            (m.start, m.end) for r in kept for m in _unmute_spans(r) if m.track_id == span.track_id
        ]
        for lo, hi in subtract_intervals([(span.start, span.end)], claimed):
            for clip in clips_for_track(project, span.track_id):
                subtract_source_mute(clip, lo, hi)


_RESTORERS: dict[str, _Restorer] = {"unmute": _Restorer(_plan_unmute, _apply_unmute)}


def plan_restore(
    project: EpisodeProject, record: AppliedEditRecord, batch: frozenset[str] = frozenset()
) -> RestorePlan | RestoreConflict:
    """Plan restoring ``record`` alongside the other records in ``batch``; never raises."""
    inverse = record.inverse
    if inverse is None:
        return RestoreConflict(
            code=LOCAL_RESTORE_REQUIRES_HISTORY,
            record_id=record.id,
            message=LOCAL_RESTORE_MESSAGE,
        )
    conflict = _RESTORERS[inverse.kind].plan(project, record, inverse, batch | {record.id})
    if conflict is not None:
        return conflict
    return RestorePlan(record.id, tuple(dict.fromkeys(s.track_id for s in inverse.spans)))


def restore_state(project: EpisodeProject, record: AppliedEditRecord) -> RestoreState:
    plan = plan_restore(project, record)
    if isinstance(plan, RestoreConflict):
        return RestoreState(
            state="history_only" if plan.code == LOCAL_RESTORE_REQUIRES_HISTORY else "blocked",
            code=plan.code,
            message=plan.message,
            blocked_by=plan.blocked_by,
        )
    return RestoreState(state="ready")


def plan_restores(
    project: EpisodeProject, ids: Sequence[str]
) -> tuple[list[RestorePlan], list[RestoreConflict]]:
    by_id = {r.id: r for r in project.editorial.edit_log}
    batch = frozenset(ids)
    plans: list[RestorePlan] = []
    conflicts: list[RestoreConflict] = []
    for record_id in dict.fromkeys(ids):
        record = by_id.get(record_id)
        if record is None:
            conflicts.append(
                RestoreConflict(
                    code="applied_edit_not_found",
                    record_id=record_id,
                    message=f"Applied edit {record_id} is not in this project.",
                )
            )
            continue
        planned = plan_restore(project, record, batch)
        if isinstance(planned, RestoreConflict):
            conflicts.append(planned)
        else:
            plans.append(planned)
    return plans, conflicts


def planned_summary(plans: Sequence[RestorePlan]) -> dict[str, Any]:
    tracks = list(dict.fromkeys(t for p in plans for t in p.track_ids))
    return {
        "operation": "revert_applied_edit",
        "ids": [p.record_id for p in plans],
        "affected_tracks": tracks,
    }


def apply_restores(
    project: EpisodeProject, plans: Sequence[RestorePlan], *, defaults: EffectiveConfig
) -> dict[str, Any]:
    done = {p.record_id for p in plans}
    kept = [r for r in project.editorial.edit_log if r.id not in done]
    for record in project.editorial.edit_log:
        if record.id in done:
            if record.inverse is None:
                raise CodedValueError(
                    f"applied edit {record.id} has no inverse to apply",
                    code="restore_without_inverse",
                )
            _RESTORERS[record.inverse.kind].apply(project, record.inverse, kept)
    project.editorial.edit_log = kept
    rebuild_combined(project, defaults=defaults)
    update_timeline_duration(project)
    summary = planned_summary(plans)
    return change_summary(
        project,
        duration_sec=0.0,
        track_ids=summary["affected_tracks"],
        **summary,
    )
