"""Change one applied non-speech action without undoing siblings (#1434 5b)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.non_speech_outcomes import (
    apply_non_speech_outcome_to_project,
    get_non_speech_outcome,
    revert_non_speech_outcome,
)
from podcast_mcp.edits.non_speech_suggestions import NonSpeechAction
from podcast_mcp.models import EpisodeProject


def change_non_speech_action(
    project: EpisodeProject,
    outcome_id: str,
    new_action: NonSpeechAction | str,
    *,
    confirm_cut_speech: bool = False,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    action = (
        new_action if isinstance(new_action, NonSpeechAction) else NonSpeechAction(str(new_action))
    )
    outcome = get_non_speech_outcome(project, outcome_id)
    prior = outcome.applied_action
    if action.value == prior:
        return {
            "operation": "change_non_speech_action",
            "outcome_id": outcome_id,
            "from": prior,
            "to": action.value,
            "changed": False,
        }
    revert_non_speech_outcome(project, outcome)
    updated = apply_non_speech_outcome_to_project(
        project,
        outcome,
        action,
        confirm_cut_speech=confirm_cut_speech,
        defaults=defaults,
    )
    return {
        "operation": "change_non_speech_action",
        "outcome_id": updated.id,
        "from": prior,
        "to": updated.applied_action,
        "changed": True,
    }
