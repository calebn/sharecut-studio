"""Apply pending non-speech suggestions per D-non-speech-sound-actions (#1434)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from podcast_mcp.edits.cut_speech import UnconfirmedCutSpeech
from podcast_mcp.edits.decisions import approve_edits, reject_edits
from podcast_mcp.edits.non_speech_outcomes import (
    apply_lower_for_decision,
    attenuation_db,
    record_non_speech_outcome,
    shorten_end,
)
from podcast_mcp.edits.non_speech_suggestions import (
    NonSpeechAction,
    pending_non_speech_suggestions,
    resolve_suggested_action,
)
from podcast_mcp.edits.timeline_span import map_source_span_fields
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject


def _find_edit_log_for_decision(project: EpisodeProject, decision_id: str):
    for record in reversed(project.editorial.edit_log):
        if decision_id in record.decision_ids:
            return record
    return None


def apply_non_speech_suggested_actions(
    project: EpisodeProject,
    *,
    ids: list[str] | None = None,
    confirm_cut_speech: bool = False,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply each pending non-speech suggestion's resolved action in one pass."""
    pending = pending_non_speech_suggestions(project.edit_decisions)
    if ids is not None:
        wanted = set(ids)
        pending = [d for d in pending if d.id in wanted]
    if not pending:
        return {
            "operation": "apply_suggested_non_speech_actions",
            "applied_cuts": 0,
            "left": 0,
            "lowered": 0,
            "shortened": 0,
            "cuts_over_peer": 0,
            "outcomes": 0,
        }

    batch_id = f"nsb_{uuid4().hex[:8]}"
    to_cut: list = []
    to_leave: list = []
    to_lower: list = []
    to_shorten: list = []
    for decision in pending:
        action = resolve_suggested_action(project, decision)
        if action is None:
            continue
        if action == NonSpeechAction.CUT:
            to_cut.append(decision)
        elif action == NonSpeechAction.LEAVE:
            to_leave.append(decision)
        elif action == NonSpeechAction.LOWER:
            to_lower.append(decision)
        elif action == NonSpeechAction.SHORTEN:
            to_shorten.append(decision)

    left = 0
    for decision in to_leave:
        record_non_speech_outcome(
            project,
            decision,
            NonSpeechAction.LEAVE,
            batch_id=batch_id,
        )
        left += reject_edits(project, [decision.id])

    att_db = attenuation_db(defaults)
    lowered = 0
    for decision in to_lower:
        point_ids = apply_lower_for_decision(project, decision, att_db)
        if point_ids is None:
            continue
        _mappable, _spans, tl_start, tl_end = map_source_span_fields(
            SessionTimeline(project), decision.track_id, decision.start, decision.end
        )
        record_non_speech_outcome(
            project,
            decision,
            NonSpeechAction.LOWER,
            envelope_point_ids=point_ids,
            timeline_start=tl_start,
            timeline_end=tl_end,
            attenuation_db=att_db,
            batch_id=batch_id,
        )
        reject_edits(project, [decision.id])
        lowered += 1

    shortened = 0
    shorten_effective: dict[str, float] = {}
    for decision in to_shorten:
        effective_end = shorten_end(decision)
        shorten_effective[decision.id] = effective_end
        decision.end = effective_end
        shortened += 1
        to_cut.append(decision)

    cuts_over_peer = sum(
        1 for d in to_cut if d.cut_speech is not None or ":other_speaking:" in (d.reason or "")
    )

    try:
        applied_cuts = approve_edits(
            project,
            [d.id for d in to_cut],
            confirm_cut_speech=confirm_cut_speech,
            allow_review=True,
        )
    except UnconfirmedCutSpeech as asked:
        batch = {
            "ids": [d.id for d in to_cut],
            "cuts_over_peer": cuts_over_peer,
            "left": left,
            "lowered": lowered,
            "shortened": shortened,
            "outcomes": len(project.editorial.non_speech_outcomes),
        }
        return {**asked.result("apply_suggested_non_speech_actions"), **batch}

    for decision in to_cut:
        record = _find_edit_log_for_decision(project, decision.id)
        action = (
            NonSpeechAction.SHORTEN if decision.id in shorten_effective else NonSpeechAction.CUT
        )
        eff_end = shorten_effective.get(decision.id, decision.end)
        record_non_speech_outcome(
            project,
            decision,
            action,
            edit_log_id=record.id if record is not None else None,
            timeline_start=record.timeline_start if record is not None else None,
            timeline_end=record.timeline_end if record is not None else None,
            effective_source_end=eff_end,
            batch_id=batch_id,
        )

    return {
        "operation": "apply_suggested_non_speech_actions",
        "applied_cuts": applied_cuts,
        "left": left,
        "lowered": lowered,
        "shortened": shortened,
        "cuts_over_peer": cuts_over_peer,
        "outcomes": len(project.editorial.non_speech_outcomes),
        "batch_id": batch_id,
    }
