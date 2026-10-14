"""Apply pending non-speech suggestions per D-non-speech-sound-actions (#1434)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.cut_speech import UnconfirmedCutSpeech
from podcast_mcp.edits.decisions import approve_edits, reject_edits
from podcast_mcp.edits.non_speech_suggestions import (
    NonSpeechAction,
    pending_non_speech_suggestions,
    resolve_suggested_action,
)
from podcast_mcp.edits.timeline_span import map_source_span_fields
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import AutomationEnvelope, AutomationPoint, EpisodeProject

SHORTEN_RETAIN_FRACTION = 0.45
_MIN_SHORTEN_KEEP_SEC = 0.08


def _attenuation_db(defaults: dict[str, Any] | None) -> float:
    cfg = defaults or load_defaults()
    heur = (cfg.get("analysis") or {}).get("heuristics") or {}
    return float(heur.get("bleed_attenuation_db", 20.0))


def _duck_volume_span(
    project: EpisodeProject,
    track_id: str,
    tl_start: float,
    tl_end: float,
    attenuation_db: float,
) -> bool:
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
    return True


def _apply_lower(project: EpisodeProject, decision, attenuation_db: float) -> bool:
    _mappable, _spans, tl_start, tl_end = map_source_span_fields(
        SessionTimeline(project), decision.track_id, decision.start, decision.end
    )
    if tl_start is None or tl_end is None or tl_end <= tl_start:
        return False
    return _duck_volume_span(project, decision.track_id, tl_start, tl_end, attenuation_db)


def _shorten_end(decision) -> float:
    span = max(0.0, decision.end - decision.start)
    keep = max(_MIN_SHORTEN_KEEP_SEC, span * SHORTEN_RETAIN_FRACTION)
    return decision.start + keep


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
        }

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

    left = reject_edits(project, [d.id for d in to_leave + to_lower])

    shortened = 0
    for decision in to_shorten:
        decision.end = _shorten_end(decision)
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
            "lowered": 0,
            "shortened": shortened,
        }
        return {**asked.result("apply_suggested_non_speech_actions"), **batch}

    att_db = _attenuation_db(defaults)
    lowered = sum(1 for d in to_lower if _apply_lower(project, d, att_db))

    return {
        "operation": "apply_suggested_non_speech_actions",
        "applied_cuts": applied_cuts,
        "left": left,
        "lowered": lowered,
        "shortened": shortened,
        "cuts_over_peer": cuts_over_peer,
    }
