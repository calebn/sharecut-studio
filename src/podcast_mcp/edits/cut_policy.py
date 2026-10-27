"""Pure cut-action policy: join kinds, edge checks, and the sound and safety action table.

Nothing here reads a project or audio, so ``gui/mapper.py`` can ask for a decision's policy
without loading the acoustic assessor in ``cut_safety``.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Literal, TypedDict

from podcast_mcp.edits.tighten_reasons import (
    ACOUSTIC_FILLER_REASON,
    PAUSE_REASON_PREFIX,
    REPETITION_REASON_PREFIX,
    RESTART_REASON_PREFIX,
    is_likely_laugh_reason,
    is_possible_word_reason,
)
from podcast_mcp.models import EditDecision, EditDecisionType


class CutJoin(Enum):
    SPLICE = "splice"
    PADDED = "padded"
    MUTE = "mute"


class BreathEdgeAction(Enum):
    PROTECT = "protect"
    KEEP_WHOLE = "keep_whole"
    IGNORE = "ignore"


@dataclass(frozen=True)
class CutEdgeChecks:
    breaths: BreathEdgeAction
    score_joins: bool
    end_before_next_onset: bool
    keep_whole_words: bool
    refuse_attached_runs: bool
    audible_only: bool
    peer_scoped: bool


CUT_EDGE_CHECKS = {
    CutJoin.SPLICE: CutEdgeChecks(
        breaths=BreathEdgeAction.PROTECT,
        score_joins=True,
        end_before_next_onset=False,
        keep_whole_words=False,
        refuse_attached_runs=False,
        audible_only=False,
        peer_scoped=True,
    ),
    CutJoin.PADDED: CutEdgeChecks(
        breaths=BreathEdgeAction.IGNORE,
        score_joins=False,
        end_before_next_onset=True,
        keep_whole_words=True,
        refuse_attached_runs=False,
        audible_only=False,
        peer_scoped=True,
    ),
    CutJoin.MUTE: CutEdgeChecks(
        breaths=BreathEdgeAction.KEEP_WHOLE,
        score_joins=False,
        end_before_next_onset=True,
        keep_whole_words=True,
        refuse_attached_runs=True,
        audible_only=True,
        peer_scoped=False,
    ),
}


SuggestedAction = Literal["cut", "shorten", "lower", "leave"]


CutAction = Literal["cut", "shorten", "lower", "leave", "review"]


CutMode = Literal["ripple", "mute"]


SUGGESTED_ACTIONS: tuple[SuggestedAction, ...] = ("cut", "shorten", "lower", "leave")


@dataclass(frozen=True)
class CutActionPolicy:
    label: str
    action: CutAction
    join: CutJoin | None
    editorial: bool
    proposal_review: bool
    acoustic_override: bool = False


# Review item kinds, the queue-group vocabulary the Review stage sends on every pending edit.
# ``unsure-word`` is deliberately absent: it is a separate per-edit list, not a kind.
ReviewKind = Literal["filler", "pause", "repeat", "false-start", "sound", "other"]


# (sound kind, label, default action, editorial, proposal review, review kind)
_SOUND_ACTIONS: tuple[tuple[str, str, SuggestedAction, bool, bool, ReviewKind], ...] = (
    ("filler", "Filler word", "cut", True, False, "filler"),
    ("pause", "Long pause", "shorten", True, False, "pause"),
    ("repetition", "Repeated words", "cut", True, True, "repeat"),
    ("restart", "False start", "cut", True, True, "false-start"),
    ("acoustic", "Unclear sound", "leave", False, True, "sound"),
    ("laugh", "Laugh", "lower", False, True, "sound"),
    ("possible_word", "Possible missed word", "leave", False, True, "sound"),
    ("backchannel", "Backchannel", "lower", False, False, "sound"),
    ("breath", "Breath", "leave", False, False, "sound"),
    ("mouth_click", "Mouth click", "cut", False, False, "sound"),
    ("playful_phrase", "Playful phrase", "leave", False, False, "other"),
)

_REVIEW_KIND_BY_SOUND: dict[str, ReviewKind] = {row[0]: row[5] for row in _SOUND_ACTIONS}
_LABEL_ACTION_BY_SOUND: dict[str, tuple[str, SuggestedAction]] = {
    row[0]: (row[1], row[2]) for row in _SOUND_ACTIONS
}


_SAFETY_ACTIONS = (
    ("breath_edge", True),
    ("peer_speech", True),
    ("speaker_bleed", True),
    ("join_continuity", True),
    ("source_geometry", False),
    ("pause_effect_geometry", False),
    ("pad_hull", False),
    ("pad_placement", False),
    ("pad_source_binding", False),
    ("pad_coverage", False),
    ("source_receipt", False),
    ("recording_identity", False),
    ("clip_identity", False),
    ("clip_recording_identity", False),
    ("recording_extent", False),
    ("fill_binding", False),
    ("operation_scope", False),
    ("scope_unavailable", True),
    ("media_extent_unavailable", False),
    ("stored_track_pause", False),
    ("pause_not_shorter", False),
    ("pause_imperceptible", True),
    ("pause_air", True),
    ("pause_join", True),
    ("acoustic_edge", True),
)


# Sound labels and fresh safety observations share this one mode/action table. Safety
# observation rows all retain the operation for review unless trusted intent overrides
# an acoustic row at the private-candidate boundary.
CUT_ACTION_TABLE: dict[tuple[str, CutMode], CutActionPolicy] = {
    (kind, mode): CutActionPolicy(
        label,
        action,
        CutJoin.SPLICE if mode == "ripple" else CutJoin.MUTE,
        editorial,
        proposal_review=review,
    )
    for kind, label, action, editorial, review, _review_kind in _SOUND_ACTIONS
    for mode in ("ripple", "mute")
}


CUT_ACTION_TABLE.update(
    {
        (label, mode): CutActionPolicy(
            label=label,
            action="review",
            join=None,
            editorial=False,
            proposal_review=False,
            acoustic_override=acoustic,
        )
        for label, acoustic in _SAFETY_ACTIONS
        for mode in ("ripple", "mute")
    }
)


def action_for_safety_observation(label: str, mode: CutMode) -> CutActionPolicy:
    return CUT_ACTION_TABLE[(label, mode)]


def edit_time_behavior(edit: EditDecision) -> CutMode:
    if edit.type is EditDecisionType.MUTE or edit.scope == "track" or edit.exact_range is not None:
        return "mute"
    return "ripple"


def sound_kind(reason: str | None) -> str | None:
    text = reason or ""
    if text.startswith(ACOUSTIC_FILLER_REASON):
        # A heard word outranks a laugh: "leave" is the safe default when both flags are set.
        if is_possible_word_reason(text):
            return "possible_word"
        if is_likely_laugh_reason(text):
            return "laugh"
        return "acoustic"
    if text.startswith("filler:"):
        return "filler"
    if text.startswith(PAUSE_REASON_PREFIX):
        return "pause"
    if text.startswith(REPETITION_REASON_PREFIX):
        return "repetition"
    if text.startswith(RESTART_REASON_PREFIX):
        return "restart"
    return None


def review_kind(reason: str | None) -> ReviewKind:
    """The Review queue group for a reason code; ``other`` for guest, agent and manual edits."""
    kind = sound_kind(reason)
    return _REVIEW_KIND_BY_SOUND[kind] if kind is not None else "other"


class ReviewFields(TypedDict):
    kind: ReviewKind
    sound_kind: str | None
    label: str | None
    suggested_action: SuggestedAction | None


def review_fields(reason: str | None) -> ReviewFields:
    """The four Review fields for a reason code. ``label`` and ``suggested_action`` are None exactly when ``sound_kind`` is."""
    kind = sound_kind(reason)
    label, action = _LABEL_ACTION_BY_SOUND[kind] if kind is not None else (None, None)
    return {
        "kind": review_kind(reason),
        "sound_kind": kind,
        "label": label,
        "suggested_action": action,
    }


def sound_policy(reason: str | None, mode: CutMode = "ripple") -> CutActionPolicy | None:
    kind = sound_kind(reason)
    return CUT_ACTION_TABLE[(kind, mode)] if kind is not None else None


def decision_policy(decision: EditDecision) -> CutActionPolicy | None:
    return sound_policy(
        decision.reason, "mute" if decision.type == EditDecisionType.MUTE else "ripple"
    )


def is_non_speech_sound(reason: str | None) -> bool:
    policy = sound_policy(reason)
    return policy is not None and not policy.editorial


SAFETY_LABELS = frozenset(label for label, _ in _SAFETY_ACTIONS)
