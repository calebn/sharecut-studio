"""Apply every pending sound's suggested action in one step (#1434).

``cut`` and ``shorten`` apply the proposal as a cut; a cut the speech guard would hold for
another speaker applies as the session ripple across every dialogue track (never a
one-track punch) and is counted so the summary can name it.  ``lower`` turns the sound's
span down on its own track (an optional ``gain_db`` on the clip's mute region) when another
speaker is talking over it, and otherwise leaves it.  ``leave`` dismisses the proposal and
keeps the audio.  The caller runs this inside one transaction so it is one undo step.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.decisions import edit_timeline_range
from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.mute_regions import add_source_mute, source_span_is_muted
from podcast_mcp.edits.sound_actions import SuggestedAction, sound_label_and_action
from podcast_mcp.models import ClipMuteRegion, EditDecision, EpisodeProject

log = logging.getLogger(__name__)

LOWER_DB = -12.0
LOWER_FADE_MS = 20


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
            text += f"; {self.left_no_overlap} laugh left (nobody talking over it)"
        if self.held:
            text += f"; {len(self.held)} still pending"
        return text + "."


def suggested_action_for(decision: EditDecision) -> SuggestedAction | None:
    info = sound_label_and_action(decision.reason)
    return info[1] if info else None


def another_speaker_over(project: EpisodeProject, decision: EditDecision) -> bool:
    """True when a peer track is speaking over the decision's span."""
    from podcast_mcp.edits.speech_energy_guard import assess_cross_track_speech

    try:
        return assess_cross_track_speech(
            project, decision.track_id, decision.start, decision.end
        ).blocked
    except (OSError, ValueError):
        log.debug("peer speech check unavailable for %s", decision.id, exc_info=True)
        return False


def apply_lower(project: EpisodeProject, decision: EditDecision, db: float = LOWER_DB) -> bool:
    """Turn the decision's span down on its own track; True when a clip took it."""
    mapped = edit_timeline_range(project, decision)
    if mapped is None:
        return False
    written = False
    for clip in clips_for_track(project, decision.track_id):
        if decision.end <= clip.source_start or decision.start >= clip.source_end:
            continue
        hard_muted = [r for r in clip.mute_regions if r.gain_db is None]
        if source_span_is_muted(hard_muted, decision.start, decision.end):
            continue
        region = ClipMuteRegion(
            start_s=decision.start,
            end_s=decision.end,
            fade_out_ms=LOWER_FADE_MS,
            fade_in_ms=LOWER_FADE_MS,
            gain_db=db,
        )
        written = add_source_mute(clip, region) or written
    if not written:
        return False
    archive_decision(
        project,
        decision,
        operation="approve_edits",
        timeline_start=mapped[0],
        timeline_end=mapped[1],
        track_ids=[decision.track_id],
        params={
            "scope": "track",
            "mute": True,
            "lowered_db": db,
            "per_track_source": {decision.track_id: [decision.start, decision.end]},
        },
    )
    return True
