"""Persisted non-speech apply outcomes and per-sound action changes (#1434 5b)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.decisions import _source_extents
from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.non_speech_suggestions import (
    NonSpeechAction,
    classify_non_speech_kind,
    non_speech_view_for_decision,
)
from podcast_mcp.edits.source_removals import CutScopeHold, consume_source_remove
from podcast_mcp.edits.timeline_ops import paste_segment
from podcast_mcp.edits.timeline_span import map_source_span_fields
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    EditDecision,
    EditDecisionType,
    EditMode,
    EpisodeProject,
    NonSpeechOutcome,
)
from podcast_mcp.util.coded_error import CodedError, CodedKeyError

AppliedNonSpeechAction = Literal["cut", "shorten", "lower", "leave"]
SHORTEN_RETAIN_FRACTION = 0.45
_MIN_SHORTEN_KEEP_SEC = 0.08


def attenuation_db(defaults: dict[str, Any] | None) -> float:
    cfg = defaults or load_defaults()
    heur = (cfg.get("analysis") or {}).get("heuristics") or {}
    return float(heur.get("bleed_attenuation_db", 20.0))


def duck_volume_span(
    project: EpisodeProject,
    track_id: str,
    tl_start: float,
    tl_end: float,
    attenuation_db: float,
) -> list[str]:
    factor = 10 ** (-attenuation_db / 20.0)
    envelope = project.volume_envelope_for(track_id)
    existing = list(envelope.points) if envelope is not None else []
    if not existing:
        base = 1.0
    else:
        base = existing[0].value
        for point in existing:
            if point.time <= tl_start:
                base = point.value
    dipped = max(0.0, base * factor)
    eps = 0.001
    t0 = max(0.0, tl_start - eps)
    t1 = min(project.timeline.duration_sec, tl_end + eps)
    new_points = [
        AutomationPoint(id=str(uuid4()), time=t0, value=base),
        AutomationPoint(id=str(uuid4()), time=tl_start, value=dipped),
        AutomationPoint(id=str(uuid4()), time=tl_end, value=dipped),
        AutomationPoint(id=str(uuid4()), time=t1, value=base),
    ]
    point_ids = [p.id for p in new_points]
    merged = sorted(existing + new_points, key=lambda p: p.time)
    if envelope is None:
        project.automation_envelopes.append(
            AutomationEnvelope(track_id=track_id, parameter="volume", points=merged)
        )
    else:
        index = next(i for i, e in enumerate(project.automation_envelopes) if e is envelope)
        project.automation_envelopes[index] = AutomationEnvelope(
            track_id=track_id, parameter=envelope.parameter, points=merged
        )
    return point_ids


def apply_lower_for_decision(
    project: EpisodeProject, decision: EditDecision, att_db: float
) -> list[str] | None:
    _mappable, _spans, tl_start, tl_end = map_source_span_fields(
        SessionTimeline(project), decision.track_id, decision.start, decision.end
    )
    if tl_start is None or tl_end is None or tl_end <= tl_start:
        return None
    return duck_volume_span(project, decision.track_id, tl_start, tl_end, att_db)


def shorten_end(decision: EditDecision) -> float:
    span = max(0.0, decision.end - decision.start)
    keep = max(_MIN_SHORTEN_KEEP_SEC, span * SHORTEN_RETAIN_FRACTION)
    return decision.start + keep


class NonSpeechOutcomeStale(CodedError, ValueError):
    code = "non_speech_outcome_stale"

    def __init__(self, outcome_id: str) -> None:
        self.outcome_id = outcome_id
        super().__init__(
            "This non-speech outcome no longer matches the timeline. "
            "Undo later edits first, then try again."
        )


def _new_outcome_id() -> str:
    return f"nso_{uuid.uuid4().hex[:8]}"


def get_non_speech_outcome(project: EpisodeProject, outcome_id: str) -> NonSpeechOutcome:
    for row in project.editorial.non_speech_outcomes:
        if row.id == outcome_id:
            return row
    raise CodedKeyError(
        f"non-speech outcome not found: {outcome_id}", code="non_speech_outcome_not_found"
    )


def list_non_speech_outcomes(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
) -> list[NonSpeechOutcome]:
    rows = project.editorial.non_speech_outcomes
    if track_id is None:
        return list(rows)
    return [row for row in rows if row.track_id == track_id]


def _replace_outcome(project: EpisodeProject, outcome: NonSpeechOutcome) -> None:
    project.editorial.non_speech_outcomes = [
        outcome if row.id == outcome.id else row for row in project.editorial.non_speech_outcomes
    ]


def build_source_paste_extracts(
    project: EpisodeProject,
    track_id: str,
    source_start: float,
    source_end: float,
) -> list[dict[str, Any]]:
    if source_end <= source_start:
        raise ValueError("source_end must be after source_start")
    return [
        {
            "track_id": track_id,
            "source_start": source_start,
            "source_end": source_end,
            "relative_timeline_start": 0.0,
        }
    ]


def remove_envelope_points(project: EpisodeProject, track_id: str, point_ids: list[str]) -> bool:
    if not point_ids:
        return False
    envelope = project.volume_envelope_for(track_id)
    if envelope is None:
        return False
    drop = set(point_ids)
    kept = [p for p in envelope.points if p.id not in drop]
    if len(kept) == len(envelope.points):
        return False
    index = next(i for i, e in enumerate(project.automation_envelopes) if e is envelope)
    project.automation_envelopes[index] = envelope.model_copy(update={"points": kept})
    return True


def record_non_speech_outcome(
    project: EpisodeProject,
    decision: EditDecision,
    action: NonSpeechAction,
    *,
    edit_log_id: str | None = None,
    envelope_point_ids: list[str] | None = None,
    timeline_start: float | None = None,
    timeline_end: float | None = None,
    effective_source_end: float | None = None,
    attenuation_db: float | None = None,
    batch_id: str | None = None,
) -> NonSpeechOutcome:
    view = non_speech_view_for_decision(project, decision)
    kind = (view or {}).get("non_speech_kind") or (classify_non_speech_kind(decision.reason) or "")
    label = (view or {}).get("non_speech_label") or kind or "Sound"
    eff_end = effective_source_end if effective_source_end is not None else decision.end
    ripple = None
    if timeline_start is not None and timeline_end is not None:
        ripple = max(0.0, float(timeline_end) - float(timeline_start))
    outcome = NonSpeechOutcome(
        id=_new_outcome_id(),
        decision_id=decision.id,
        track_id=decision.track_id,
        kind=str(kind),
        label=str(label),
        source_start=decision.start,
        source_end=decision.end,
        applied_action=action.value,
        applied_at=datetime.now(UTC).isoformat(),
        effective_source_start=decision.start,
        effective_source_end=eff_end,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        ripple_duration_sec=ripple,
        edit_log_id=edit_log_id,
        envelope_point_ids=list(envelope_point_ids or []),
        attenuation_db=attenuation_db,
        batch_id=batch_id,
    )
    project.editorial.non_speech_outcomes.append(outcome)
    if edit_log_id:
        for record in project.editorial.edit_log:
            if record.id == edit_log_id:
                record.params["non_speech_outcome_id"] = outcome.id
                break
    return outcome


def _remove_edit_log(project: EpisodeProject, record_id: str | None) -> None:
    if not record_id:
        return
    project.editorial.edit_log = [r for r in project.editorial.edit_log if r.id != record_id]


def revert_non_speech_outcome(project: EpisodeProject, outcome: NonSpeechOutcome) -> None:
    action = outcome.applied_action
    if action == "leave":
        return
    if action == "lower":
        remove_envelope_points(project, outcome.track_id, outcome.envelope_point_ids)
        return
    if action in ("cut", "shorten"):
        if outcome.timeline_start is None or outcome.ripple_duration_sec is None:
            raise NonSpeechOutcomeStale(outcome.id)
        duration = max(0.0, float(outcome.ripple_duration_sec))
        if duration <= 0:
            raise NonSpeechOutcomeStale(outcome.id)
        extracts = build_source_paste_extracts(
            project,
            outcome.track_id,
            outcome.source_start,
            outcome.source_end,
        )
        paste_segment(
            project,
            insert_at=float(outcome.timeline_start),
            duration=duration,
            extracts=extracts,
            mode=EditMode.RIPPLE,
        )
        _remove_edit_log(project, outcome.edit_log_id)
        return
    raise ValueError(f"unknown applied_action: {action!r}")


def _synthetic_remove_decision(outcome: NonSpeechOutcome, source_end: float) -> EditDecision:
    return EditDecision(
        id=outcome.decision_id,
        track_id=outcome.track_id,
        type=EditDecisionType.REMOVE,
        start=outcome.source_start,
        end=source_end,
        reason=f"non_speech:{outcome.kind}",
        review_required=False,
        applied=False,
    )


def _apply_cut_outcome(
    project: EpisodeProject,
    outcome: NonSpeechOutcome,
    *,
    shorten: bool,
    confirm_cut_speech: bool,
) -> tuple[str | None, float | None, float | None]:
    from podcast_mcp.edits.cut_speech import CutSpeechConfirmation, UnconfirmedCutSpeech

    source_end = (
        shorten_end(_synthetic_remove_decision(outcome, outcome.source_end))
        if shorten
        else outcome.source_end
    )
    edit = _synthetic_remove_decision(outcome, source_end)
    batch = _source_extents([edit])
    applied = consume_source_remove(
        project,
        edit,
        confirm_cut_speech=confirm_cut_speech,
        allow_review=True,
        batch=batch,
        use_inaudible_opt=False,
        record_log=False,
    )
    if isinstance(applied, CutSpeechConfirmation):
        raise UnconfirmedCutSpeech(applied)
    if isinstance(applied, CutScopeHold):
        raise NonSpeechOutcomeStale(outcome.id)
    tl_start, tl_end, track_ids, params = applied
    if not track_ids:
        raise NonSpeechOutcomeStale(outcome.id)
    record = archive_decision(
        project,
        edit,
        operation="change_non_speech_action",
        timeline_start=tl_start,
        timeline_end=tl_end,
        track_ids=track_ids,
        params=params,
    )
    record.params["non_speech_outcome_id"] = outcome.id
    return record.id, tl_start, tl_end


def apply_non_speech_outcome_to_project(
    project: EpisodeProject,
    outcome: NonSpeechOutcome,
    action: NonSpeechAction,
    *,
    confirm_cut_speech: bool = False,
    defaults: dict[str, Any] | None = None,
) -> NonSpeechOutcome:
    if action == NonSpeechAction.LEAVE:
        updated = outcome.model_copy(
            update={
                "applied_action": action.value,
                "applied_at": datetime.now(UTC).isoformat(),
                "effective_source_start": outcome.source_start,
                "effective_source_end": outcome.source_end,
                "timeline_start": None,
                "timeline_end": None,
                "ripple_duration_sec": None,
                "edit_log_id": None,
                "envelope_point_ids": [],
                "attenuation_db": None,
            }
        )
        _replace_outcome(project, updated)
        return updated

    if action == NonSpeechAction.LOWER:
        att_db = attenuation_db(defaults)
        decision = _synthetic_remove_decision(outcome, outcome.source_end)
        point_ids = apply_lower_for_decision(project, decision, att_db)
        if point_ids is None:
            raise NonSpeechOutcomeStale(outcome.id)
        _mappable, _spans, tl_start, tl_end = map_source_span_fields(
            SessionTimeline(project), decision.track_id, decision.start, decision.end
        )
        updated = outcome.model_copy(
            update={
                "applied_action": action.value,
                "applied_at": datetime.now(UTC).isoformat(),
                "effective_source_start": outcome.source_start,
                "effective_source_end": outcome.source_end,
                "timeline_start": tl_start,
                "timeline_end": tl_end,
                "ripple_duration_sec": None,
                "edit_log_id": None,
                "envelope_point_ids": point_ids,
                "attenuation_db": att_db,
            }
        )
        _replace_outcome(project, updated)
        return updated

    if action in (NonSpeechAction.CUT, NonSpeechAction.SHORTEN):
        shorten = action == NonSpeechAction.SHORTEN
        edit_log_id, tl_start, tl_end = _apply_cut_outcome(
            project,
            outcome,
            shorten=shorten,
            confirm_cut_speech=confirm_cut_speech,
        )
        eff_end = (
            shorten_end(_synthetic_remove_decision(outcome, outcome.source_end))
            if shorten
            else outcome.source_end
        )
        ripple = None
        if tl_start is not None and tl_end is not None:
            ripple = max(0.0, float(tl_end) - float(tl_start))
        updated = outcome.model_copy(
            update={
                "applied_action": action.value,
                "applied_at": datetime.now(UTC).isoformat(),
                "effective_source_start": outcome.source_start,
                "effective_source_end": eff_end,
                "timeline_start": tl_start,
                "timeline_end": tl_end,
                "ripple_duration_sec": ripple,
                "edit_log_id": edit_log_id,
                "envelope_point_ids": [],
                "attenuation_db": None,
            }
        )
        _replace_outcome(project, updated)
        return updated

    raise ValueError(f"unknown action: {action!r}")
