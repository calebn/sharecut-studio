"""Apply pending sounds' suggested actions in one transaction (#1434).

``cut`` and ``shorten`` apply the proposal through fresh cut policy. Only trusted human
application intent can override acoustic peer holds; programmatic confirmation cannot.
``lower`` reduces the sound on its own track when another speaker overlaps, otherwise
leaving it. ``leave`` dismisses the proposal and keeps the audio.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.edits.cut_safety import decision_policy
from podcast_mcp.edits.decisions import edit_timeline_range
from podcast_mcp.models import (
    EditDecision,
    EpisodeProject,
)

log = logging.getLogger(__name__)


@dataclass
class SuggestedActionsResult:
    """What one Apply suggested actions did, by action, with what stayed pending."""

    applied: dict[str, int] = field(default_factory=dict)
    cut_over_speaker: int = 0
    held: list[str] = field(default_factory=list)
    left_no_overlap: int = 0

    def to_payload(self) -> dict[str, Any]:
        return {
            "applied": dict(self.applied),
            "applied_count": sum(self.applied.values()),
            "cut_over_speaker": self.cut_over_speaker,
            "held": list(self.held),
            "lowered_to_leave": self.left_no_overlap,
            "summary": self.summary(),
        }

    def summary(self) -> str:
        parts = [f"{n} {action}" for action, n in self.applied.items() if n]
        text = "Applied " + (", ".join(parts) if parts else "nothing")
        if self.cut_over_speaker:
            text += f"; {self.cut_over_speaker} cut over another speaker"
        if self.left_no_overlap:
            text += f"; {self.left_no_overlap} left (nobody talking over it)"
        if self.held:
            text += f"; {len(self.held)} still pending"
        return text + "."


def describe_sounds(
    project: EpisodeProject, decisions: list[EditDecision], actions: dict[str, str]
) -> list[dict[str, Any]]:
    """What the batch history entry remembers of each sound, so a client can list the batch.

    A sound leaves ``edit_decisions`` once its action applies, so its label and place on the
    timeline are read here, before the batch runs.
    """
    rows: list[dict[str, Any]] = []
    for decision in decisions:
        info = decision_policy(decision)
        mapped = edit_timeline_range(project, decision)
        action = actions[decision.id]
        if action == "lower" and not another_speaker_over(project, decision):
            action = "leave"  # what apply_suggested_to_project will do with it
        rows.append(
            {
                "id": decision.id,
                "label": info.label if info else decision.reason,
                "track_id": decision.track_id,
                "timeline_start": mapped[0] if mapped else None,
                "action": action,
            }
        )
    return rows


def another_speaker_over(project: EpisodeProject, decision: EditDecision) -> bool:
    """True when a peer track is speaking over the decision's span."""
    from podcast_mcp.edits import cut_safety

    try:
        return cut_safety.assess_cross_track_speech(
            project, decision.track_id, decision.start, decision.end
        ).blocked
    except (OSError, ValueError):
        log.debug("peer speech check unavailable for %s", decision.id, exc_info=True)
        return False
