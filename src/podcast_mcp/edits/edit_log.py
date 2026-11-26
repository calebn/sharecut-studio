from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.reinsert import SeamConflict, apply_reinsert, locate_seam
from podcast_mcp.engines.clips_ops import (
    clips_for_track,
    update_timeline_duration,
)
from podcast_mcp.engines.mute_regions import (
    mute_regions_overlapping,
    same_region_span,
    spans_touch,
    subtract_source_mute,
)
from podcast_mcp.engines.off_speaker_regions import remove_off_speaker_mute
from podcast_mcp.engines.session_timeline import (
    clip_timeline_overlap_to_source,
    seam_source_clocks_over_clips,
)
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    AppliedEditInverse,
    AppliedEditRecord,
    Clip,
    ClipOffSpeakerMuteRegion,
    EditDecision,
    EpisodeProject,
    ReinsertClips,
    UnmuteSource,
    UnmuteSpan,
)
from podcast_mcp.models.episode import ExactRangeTarget
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
RANGE_MUTE_OPERATION = "edit_selected_range"
OVERLAPPED_BY_UNRESTORABLE_MUTE = "overlapped_by_unrestorable_mute"
UNRESTORABLE_MUTE_MESSAGE = (
    "A later mute that can't be undone on its own covers some of this audio. "
    "Use History Undo to take that mute back first."
)
GUEST_UNRESTORABLE_MUTE_MESSAGE = (
    "A later mute covers some of this audio and can't be put back on its own. Ask the host."
)
GUEST_LOCAL_RESTORE_MESSAGE = (
    "This cut can't be put back on its own. "
    "Undo takes back your own latest change; for anything else, ask the host."
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
    inverse: AppliedEditInverse | None = None,
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
        inverse=inverse,
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
    apply: Callable[
        [EpisodeProject, AppliedEditRecord, Any, EffectiveConfig, Sequence[AppliedEditRecord]], None
    ]
    track_ids: Callable[[AppliedEditRecord, Any], tuple[str, ...]]


def _off_speaker(record: AppliedEditRecord) -> bool:
    # Off-speaker records written before this key existed read as ordinary mutes.
    return record.params.get("mute_ownership") == "off_speaker"


def _unmute_spans(record: AppliedEditRecord) -> list[tuple[UnmuteSpan, bool]]:
    """``record``'s spans with whether they live in ``off_speaker_mute_regions``."""
    if not isinstance(record.inverse, UnmuteSource):
        return []
    off = _off_speaker(record)
    return [(span, off) for span in record.inverse.spans]


def _span_clips(project: EpisodeProject, record: AppliedEditRecord, span: UnmuteSpan) -> list[Clip]:
    """The clips ``span`` was written to.

    A range mute writes only clips of the span's own source (``None`` included), which its
    exactness check relies on. Older records name one source for every equivalent clip of
    the recording, so they take the whole track.
    """
    clips = clips_for_track(project, span.track_id)
    if record.operation != RANGE_MUTE_OPERATION:
        return clips
    return [clip for clip in clips if clip.source_id == span.source_id]


def _is_exact_span(region: ClipOffSpeakerMuteRegion, span: UnmuteSpan) -> bool:
    return same_region_span(region.start_s, region.end_s, span.start, span.end)


def _shares_source(
    record: AppliedEditRecord, span: UnmuteSpan, other: AppliedEditRecord, other_span: UnmuteSpan
) -> bool:
    """False when two range-mute spans sit on different recordings (``None`` matches only ``None``).

    Older records name one source for the whole track, so any pair that includes one is shared.
    """
    if not (record.operation == other.operation == RANGE_MUTE_OPERATION):
        return True
    return span.source_id == other_span.source_id


def _span_is_muted(
    project: EpisodeProject, record: AppliedEditRecord, span: UnmuteSpan, off_speaker: bool
) -> bool:
    return any(
        clip.source_start < span.end
        and clip.source_end > span.start
        and (
            any(_is_exact_span(r, span) for r in clip.off_speaker_mute_regions)
            if off_speaker
            else mute_regions_overlapping(clip.mute_regions, span.start, span.end)
        )
        for clip in _span_clips(project, record, span)
    )


def _later_source_spans(
    record: AppliedEditRecord, track_id: str
) -> list[tuple[float, float, str | None]] | None:
    """Source seconds a later mute record covered on ``track_id``; None when it cannot be told."""
    exact = record.params.get("exact_range")
    if exact is not None:
        try:
            target = ExactRangeTarget.model_validate(exact)
        except ValidationError:
            return None
        spans: list[tuple[float, float, str | None]] = []
        for clip in target.clips:
            if clip.track_id != track_id:
                continue
            for interval in target.intervals:
                a, b = (
                    max(interval.start, clip.timeline_start),
                    min(interval.end, clip.timeline_end),
                )
                mapped = clip_timeline_overlap_to_source(clip, a, b) if b > a else None
                if mapped is not None:
                    spans.append((mapped[0], mapped[1], clip.source_id))
        return spans
    per_track = record.params.get("per_track_source")
    if isinstance(per_track, dict) and isinstance(per_track.get(track_id), list | tuple):
        lo, hi = per_track[track_id]
        return [(float(lo), float(hi), record.params.get("source_id"))]
    return None


def _later_mute_may_cover(record: AppliedEditRecord, span: UnmuteSpan, off_speaker: bool) -> bool:
    """True when a later mute with no inverse of its own may cover ``span``'s audio.

    Restoring ``span`` would unmute what that mute also silenced, and it cannot be taken
    back on its own, so anything not provably disjoint in source seconds counts.
    """
    params = record.params
    # "action" is written by range edits, "mute" by the approved-mute path (_apply_mute_edit).
    if record.inverse is not None or not (params.get("action") == "mute" or params.get("mute")):
        return False
    if _off_speaker(record) != off_speaker:
        return False
    exact = params.get("exact_range")
    tracks = set(record.track_ids)
    if isinstance(exact, dict):
        tracks.update(exact.get("track_ids") or [])
    if span.track_id not in tracks:
        return False
    spans = _later_source_spans(record, span.track_id)
    if spans is None:
        return True
    return any(
        (span.source_id is None or sid is None or sid == span.source_id)
        and spans_touch(lo, hi, span.start, span.end)
        for lo, hi, sid in spans
    )


def _later_cut_overlaps(record: AppliedEditRecord, spans: Sequence[UnmuteSpan]) -> bool:
    """True when a restorable later cut took out material that overlaps ``spans`` in source seconds."""
    if not isinstance(record.inverse, ReinsertClips):
        return False
    return any(
        removed.track_id == span.track_id
        and (span.source_id is None or removed.source_id == span.source_id)
        and removed.source_start < span.end
        and removed.source_end > span.start
        for seam in record.inverse.tracks
        for removed in seam.removed
        for span in spans
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
            (m.track_id, off) == (s.track_id, _off_speaker(record))
            and _shares_source(r, m, record, s)
            and m.start < s.end
            and m.end > s.start
            for m, off in _unmute_spans(r)
            for s in inverse.spans
        )
    ]
    # A later cut keeps the mute in the clips it took out, so restoring the cut first matters;
    # a cut in the batch still blocks so that it restores first.
    blocked_by += [
        r.id for r in later if r.id not in blocked_by and _later_cut_overlaps(r, inverse.spans)
    ]
    if blocked_by:
        return RestoreConflict(
            code="overlapped_by_later",
            record_id=record.id,
            track_id=inverse.spans[0].track_id,
            blocked_by=blocked_by,
            message=(
                "A later edit mutes or cuts some of the same audio. "
                f"Restore {', '.join(blocked_by)} first, or restore them together."
            ),
        )
    off_speaker = _off_speaker(record)
    if any(
        r.id not in batch and _later_mute_may_cover(r, s, off_speaker)
        for r in later
        for s in inverse.spans
    ):
        return RestoreConflict(
            code=OVERLAPPED_BY_UNRESTORABLE_MUTE,
            record_id=record.id,
            track_id=inverse.spans[0].track_id,
            message=UNRESTORABLE_MUTE_MESSAGE,
        )
    if not any(_span_is_muted(project, record, s, off_speaker) for s in inverse.spans):
        return RestoreConflict(
            code="span_not_present",
            record_id=record.id,
            track_id=inverse.spans[0].track_id,
            message="The audio this edit muted is no longer in the project.",
        )
    return None


def _apply_unmute(
    project: EpisodeProject,
    record: AppliedEditRecord,
    inverse: UnmuteSource,
    _defaults: EffectiveConfig,
    kept: Sequence[AppliedEditRecord],
) -> None:
    """Take back the spans the record wrote, except what a record that stays still claims.

    An off-speaker span is one exact region, so it is removed whole rather than carved.
    """
    off_speaker = _off_speaker(record)
    for span in inverse.spans:
        claimed = [
            (m.start, m.end)
            for r in kept
            for m, off in _unmute_spans(r)
            if (m.track_id, off) == (span.track_id, off_speaker)
            and _shares_source(r, m, record, span)
        ]
        if off_speaker:
            if any(same_region_span(a, b, span.start, span.end) for a, b in claimed):
                continue
            for clip in _span_clips(project, record, span):
                remove_off_speaker_mute(clip, span.start, span.end)
            continue
        for lo, hi in subtract_intervals([(span.start, span.end)], claimed):
            for clip in _span_clips(project, record, span):
                subtract_source_mute(clip, lo, hi)


def _plan_reinsert(
    project: EpisodeProject,
    record: AppliedEditRecord,
    inverse: ReinsertClips,
    _batch: frozenset[str],
) -> RestoreConflict | None:
    located = locate_seam(project, record, inverse)
    if isinstance(located, SeamConflict):
        return RestoreConflict(
            code=located.code,
            record_id=record.id,
            message=located.message,
            track_id=located.track_id,
            blocked_by=list(located.blocked_by),
        )
    return None


_RESTORERS: dict[str, _Restorer] = {
    "unmute": _Restorer(
        _plan_unmute,
        _apply_unmute,
        lambda _record, inverse: tuple(dict.fromkeys(s.track_id for s in inverse.spans)),
    ),
    "reinsert_clips": _Restorer(
        _plan_reinsert,
        lambda project, record, inverse, defaults, _kept: apply_reinsert(
            project, record, inverse, defaults=defaults
        ),
        lambda record, _inverse: tuple(record.track_ids),
    ),
}


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
    restorer = _RESTORERS[inverse.kind]
    conflict = restorer.plan(project, record, inverse, batch | {record.id})
    if conflict is not None:
        return conflict
    return RestorePlan(record.id, restorer.track_ids(record, inverse))


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


def _restore_one(
    project: EpisodeProject,
    record: AppliedEditRecord,
    done: frozenset[str],
    defaults: EffectiveConfig,
) -> None:
    """Apply one inverse and drop its record; ``done`` is every id the batch restores."""
    if record.inverse is None:
        raise CodedValueError(
            f"applied edit {record.id} has no inverse to apply",
            code="restore_without_inverse",
        )
    kept = [r for r in project.editorial.edit_log if r.id not in done]
    _RESTORERS[record.inverse.kind].apply(project, record, record.inverse, defaults, kept)
    project.editorial.edit_log = [r for r in project.editorial.edit_log if r.id != record.id]


def plan_restores(
    project: EpisodeProject, ids: Sequence[str], *, defaults: EffectiveConfig
) -> tuple[list[RestorePlan], list[RestoreConflict]]:
    """Plan ``ids`` in an order that works, a record that blocks another restoring first.

    Several ids are planned on a scratch copy, applying each as it becomes ready, so a
    record blocked only by another in the set is still ready. No partial result: any
    record left blocked, or unknown, is a conflict and nothing restores.
    """
    by_id = {r.id: r for r in project.editorial.edit_log}
    batch = frozenset(ids)
    unique = list(dict.fromkeys(ids))
    conflicts = [
        RestoreConflict(
            code="applied_edit_not_found",
            record_id=record_id,
            message=f"Applied edit {record_id} is not in this project.",
        )
        for record_id in unique
        if record_id not in by_id
    ]
    pending = [record_id for record_id in unique if record_id in by_id]
    scratch = project if len(pending) == 1 else project.model_copy(deep=True)
    plans: list[RestorePlan] = []
    blocked: dict[str, RestoreConflict] = {}
    while pending:
        progressed = False
        for record_id in list(pending):
            record = next(r for r in scratch.editorial.edit_log if r.id == record_id)
            planned = plan_restore(scratch, record, batch)
            if isinstance(planned, RestoreConflict):
                blocked[record_id] = planned
                continue
            blocked.pop(record_id, None)
            plans.append(planned)
            pending.remove(record_id)
            progressed = True
            if scratch is not project:
                _restore_one(scratch, record, batch, defaults)
        if not progressed:
            conflicts.extend(blocked[record_id] for record_id in pending)
            break
    return ([], conflicts) if conflicts else (plans, [])


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
    done = frozenset(p.record_id for p in plans)
    for plan in plans:
        record = next(r for r in project.editorial.edit_log if r.id == plan.record_id)
        _restore_one(project, record, done, defaults)
    rebuild_combined(project, defaults=defaults)
    update_timeline_duration(project)
    summary = planned_summary(plans)
    return change_summary(
        project,
        duration_sec=0.0,
        track_ids=summary["affected_tracks"],
        **summary,
    )
