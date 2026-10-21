"""Apply pending sounds' suggested actions in one transaction (#1434).

``cut`` and ``shorten`` apply the proposal through fresh cut policy. Only trusted human
application intent can override acoustic peer holds; programmatic confirmation cannot.
``lower`` reduces the sound on its own track when another speaker overlaps, otherwise
leaving it. ``leave`` dismisses the proposal and keeps the audio.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.cut_policy import decision_policy
from podcast_mcp.edits.decisions import edit_timeline_range
from podcast_mcp.models import (
    EditDecision,
    EpisodeProject,
    SoundActionRecord,
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
    project: EpisodeProject,
    decisions: list[EditDecision],
    actions: dict[str, str],
    *,
    defaults: EffectiveConfig,
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
        if action == "lower":
            over = another_speaker_over(project, decision, defaults=defaults)
            if over is False:
                action = "leave"  # what apply_suggested_to_project will do with it
            elif over is None:
                action = "pending"  # the check could not read audio; the sound stays pending
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


def another_speaker_over(
    project: EpisodeProject, decision: EditDecision, *, defaults: EffectiveConfig
) -> bool | None:
    """True when a peer track is speaking over the span, False when none is, None when unknown.

    None means the audio could not be read; a caller must not treat it as "nobody talks over
    it", or a passing read failure becomes a recorded decision.
    """
    from podcast_mcp.edits import cut_safety

    try:
        return cut_safety.assess_cross_track_speech(
            project, decision.track_id, decision.start, decision.end, defaults=defaults
        ).blocked
    except (OSError, ValueError):
        log.debug("peer speech check unavailable for %s", decision.id, exc_info=True)
        return None


# A re-scan moves a sound's edges a little, so a decided sound is matched by overlap, not by
# equal bounds. The match is symmetric: the proposal and one record must each cover at least
# this share of the longer of the two, so a larger proposal's fresh part is never swallowed.
_DECIDED_COVERAGE = 0.75


def record_sound_action(
    project: EpisodeProject, decision: EditDecision, action: Literal["lower", "leave"]
) -> None:
    """Remember that ``decision``'s sound was lowered or left, so a re-run does not redo it."""
    from podcast_mcp.edits.cut_policy import is_non_speech_sound

    if decision.timebase != "source" or not is_non_speech_sound(decision.reason):
        return
    project.editorial.sound_actions.append(
        SoundActionRecord(
            track_id=decision.track_id,
            source_id=decision.source_id,
            start_s=decision.start,
            end_s=decision.end,
            action=action,
        )
    )


def is_decided_sound(project: EpisodeProject, decision: EditDecision) -> bool:
    """True when one recorded sound and ``decision`` cover at least 75% of each other's length.

    The record must be on the same track and the same recording (equivalent source ids, as
    ``apply_lower`` matches a clip).
    """
    sources = project.equivalent_source_ids(decision.track_id, decision.source_id)
    for record in project.editorial.sound_actions:
        if record.track_id != decision.track_id or record.source_id not in sources:
            continue
        longest = max(decision.end - decision.start, record.end_s - record.start_s)
        shared = min(decision.end, record.end_s) - max(decision.start, record.start_s)
        if longest > 0 and shared >= _DECIDED_COVERAGE * longest - 1e-9:
            return True
    return False


def drop_decided_sounds(project: EpisodeProject) -> int:
    """Drop pending non-speech proposals of sounds already lowered or left; returns the count."""
    from podcast_mcp.edits.cut_policy import is_non_speech_sound

    kept = [
        e
        for e in project.edit_decisions
        if e.applied or not is_non_speech_sound(e.reason) or not is_decided_sound(project, e)
    ]
    dropped = len(project.edit_decisions) - len(kept)
    project.edit_decisions = kept
    return dropped
