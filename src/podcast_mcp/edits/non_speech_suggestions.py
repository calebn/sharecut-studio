"""Default suggested actions for non-speech tighten proposals (D-non-speech-sound-actions).

One registry maps a detected sound kind to a plain label and a default action
(cut, shorten, lower, leave). Callers derive the kind from existing reason
strings and flags; detectors do not branch on actions.
"""

from __future__ import annotations

from enum import StrEnum
from typing import NamedTuple

from podcast_mcp.edits.speech_energy_guard import speech_words_in
from podcast_mcp.edits.tighten_hits import is_tighten_reason
from podcast_mcp.edits.tighten_reasons import is_acoustic_filler_reason, is_likely_laugh_reason
from podcast_mcp.edits.timeline_span import map_source_span_fields
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EditDecision, EpisodeProject
from podcast_mcp.util.tracks import dialogue_track_ids

BREATH_SHORTEN_MIN_SEC = 0.5
_PEER_OVERLAP_SEC = 0.02


def peer_speaks_during_decision(project: EpisodeProject, decision: EditDecision) -> bool:
    """True when another dialogue track has speech overlapping this decision on the timeline."""
    _mappable, _spans, tl_start, tl_end = map_source_span_fields(
        SessionTimeline(project), decision.track_id, decision.start, decision.end
    )
    if tl_start is None or tl_end is None or tl_end <= tl_start:
        return False
    window = (float(tl_start), float(tl_end))
    for track_id in dialogue_track_ids(project):
        if track_id == decision.track_id:
            continue
        if speech_words_in(
            project,
            track_id,
            [window],
            _PEER_OVERLAP_SEC,
            voiced=True,
        ):
            return True
    return False


NON_SPEECH_ACTION_VALUES = ("cut", "shorten", "lower", "leave")


class NonSpeechAction(StrEnum):
    CUT = "cut"
    SHORTEN = "shorten"
    LOWER = "lower"
    LEAVE = "leave"


class NonSpeechKind(StrEnum):
    FALSE_START = "false_start"
    HARD_FILLER = "hard_filler"
    MOUTH_SOUND = "mouth_sound"
    BREATH = "breath"
    LAUGH = "laugh"
    BACKCHANNEL = "backchannel"
    PLAYFUL_VOCAL = "playful_vocal"
    ACOUSTIC_UNKNOWN = "acoustic_unknown"


class NonSpeechDefaults(NamedTuple):
    kind: NonSpeechKind
    label: str
    action: NonSpeechAction


# Default action by kind (docs/filler-cut-quality.md § Non-speech sounds).
_KIND_DEFAULTS: dict[NonSpeechKind, NonSpeechDefaults] = {
    NonSpeechKind.FALSE_START: NonSpeechDefaults(
        NonSpeechKind.FALSE_START, "False start", NonSpeechAction.CUT
    ),
    NonSpeechKind.HARD_FILLER: NonSpeechDefaults(
        NonSpeechKind.HARD_FILLER, "Filler word", NonSpeechAction.CUT
    ),
    NonSpeechKind.MOUTH_SOUND: NonSpeechDefaults(
        NonSpeechKind.MOUTH_SOUND, "Mouth sound", NonSpeechAction.CUT
    ),
    NonSpeechKind.BREATH: NonSpeechDefaults(NonSpeechKind.BREATH, "Breath", NonSpeechAction.LEAVE),
    NonSpeechKind.LAUGH: NonSpeechDefaults(
        NonSpeechKind.LAUGH, "Likely laugh", NonSpeechAction.LEAVE
    ),
    NonSpeechKind.BACKCHANNEL: NonSpeechDefaults(
        NonSpeechKind.BACKCHANNEL, "Backchannel", NonSpeechAction.LEAVE
    ),
    NonSpeechKind.PLAYFUL_VOCAL: NonSpeechDefaults(
        NonSpeechKind.PLAYFUL_VOCAL, "Playful vocal phrase", NonSpeechAction.LEAVE
    ),
    NonSpeechKind.ACOUSTIC_UNKNOWN: NonSpeechDefaults(
        NonSpeechKind.ACOUSTIC_UNKNOWN, "Filler sound", NonSpeechAction.LEAVE
    ),
}


def default_action_table() -> dict[NonSpeechKind, NonSpeechAction]:
    """Kind → default action for the one table-driven contract test."""
    return {kind: row.action for kind, row in _KIND_DEFAULTS.items()}


def _kind_from_filler_reason(reason: str) -> NonSpeechKind | None:
    if not reason.startswith("filler:"):
        return None
    tail = reason[len("filler:") :]
    if tail.startswith("acoustic"):
        if is_likely_laugh_reason(reason):
            return NonSpeechKind.LAUGH
        return NonSpeechKind.ACOUSTIC_UNKNOWN
    if tail.startswith("restart:") or tail.startswith("partial:"):
        return NonSpeechKind.FALSE_START
    base = tail.split(":")[0]
    if base in {"um", "uh", "erm", "ah"}:
        return NonSpeechKind.HARD_FILLER
    if base in {"mm-hmm", "uh-huh", "mhm"}:
        return NonSpeechKind.BACKCHANNEL
    return None


def _kind_from_restart_reason(reason: str) -> NonSpeechKind | None:
    if reason.startswith("restart:"):
        return NonSpeechKind.FALSE_START
    return None


def classify_non_speech_kind(reason: str | None) -> NonSpeechKind | None:
    """Map a pending tighten reason to a non-speech kind, or None if not in scope."""
    text = reason or ""
    if not is_tighten_reason(text) and not is_acoustic_filler_reason(text):
        return None
    from_restart = _kind_from_restart_reason(text)
    if from_restart is not None:
        return from_restart
    from_filler = _kind_from_filler_reason(text)
    if from_filler is not None:
        return from_filler
    if text.startswith("repetition:"):
        return NonSpeechKind.FALSE_START
    return None


def resolve_suggested_action(
    project: EpisodeProject,
    decision: EditDecision,
) -> NonSpeechAction | None:
    """Default action from the table, with breath shorten and peer-overlap lower."""
    kind = classify_non_speech_kind(decision.reason)
    if kind is None:
        return None
    action = _KIND_DEFAULTS[kind].action
    if kind == NonSpeechKind.BREATH and (decision.end - decision.start) >= BREATH_SHORTEN_MIN_SEC:
        action = NonSpeechAction.SHORTEN
    if (
        kind in (NonSpeechKind.LAUGH, NonSpeechKind.BACKCHANNEL)
        and action == NonSpeechAction.LEAVE
        and peer_speaks_during_decision(project, decision)
    ):
        action = NonSpeechAction.LOWER
    return action


def non_speech_view_for_decision(
    project: EpisodeProject,
    decision: EditDecision,
) -> dict[str, str] | None:
    """Plain label and suggested action for a pending decision, when applicable."""
    kind = classify_non_speech_kind(decision.reason)
    if kind is None:
        return None
    row = _KIND_DEFAULTS[kind]
    action = resolve_suggested_action(project, decision) or row.action
    return {
        "non_speech_kind": row.kind.value,
        "non_speech_label": row.label,
        "suggested_action": action.value,
    }


def is_non_speech_suggestion(decision: EditDecision) -> bool:
    return classify_non_speech_kind(decision.reason) is not None


def pending_non_speech_suggestions(
    decisions: list[EditDecision],
) -> list[EditDecision]:
    """Pending tighten proposals that carry a non-speech suggested action."""
    return [d for d in decisions if not d.applied and is_non_speech_suggestion(d)]
