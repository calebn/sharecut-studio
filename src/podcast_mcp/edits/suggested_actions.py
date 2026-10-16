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
from podcast_mcp.edits.mute_regions import add_source_mute
from podcast_mcp.edits.ranges import subtract_ranges_from_intervals as subtract_intervals
from podcast_mcp.edits.sound_actions import SuggestedAction, sound_label_and_action
from podcast_mcp.models import ClipMuteRegion, EditDecision, EpisodeProject

log = logging.getLogger(__name__)

LOWER_GAIN_DB = -12.0
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
            text += f"; {self.left_no_overlap} left (nobody talking over it)"
        if self.held:
            text += f"; {len(self.held)} still pending"
        return text + "."


def suggested_action_for(decision: EditDecision) -> SuggestedAction | None:
    info = sound_label_and_action(decision.reason)
    return info[1] if info else None


def describe_sounds(
    project: EpisodeProject, decisions: list[EditDecision], actions: dict[str, str]
) -> list[dict[str, Any]]:
    """What the batch history entry remembers of each sound, so a client can list the batch.

    A sound leaves ``edit_decisions`` once its action applies, so its label and place on the
    timeline are read here, before the batch runs.
    """
    rows: list[dict[str, Any]] = []
    for decision in decisions:
        info = sound_label_and_action(decision.reason)
        mapped = edit_timeline_range(project, decision)
        action = actions[decision.id]
        if action == "lower" and not another_speaker_over(project, decision):
            action = "leave"  # what apply_suggested_to_project will do with it
        rows.append(
            {
                "id": decision.id,
                "label": info[0] if info else decision.reason,
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


def apply_lower(project: EpisodeProject, decision: EditDecision, db: float = LOWER_GAIN_DB) -> bool:
    """Turn the decision's span down on its own track; True when a clip took it."""
    mapped = edit_timeline_range(project, decision)
    if mapped is None:
        return False
    written = False
    for clip in clips_for_track(project, decision.track_id):
        if decision.end <= clip.source_start or decision.start >= clip.source_end:
            continue
        # Only the part no mute already silences: a lowered span never reopens, trims or
        # abuts a mute (render would hold the union at the mute's gain).
        hard = [(r.start_s, r.end_s) for r in clip.mute_regions if r.gain_db is None]
        for lo, hi in subtract_intervals([(decision.start, decision.end)], hard):
            if hi - lo < 1e-3:
                continue
            region = ClipMuteRegion(
                start_s=lo,
                end_s=hi,
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


def apply_suggested_to_project(
    project: EpisodeProject, actions: dict[str, str], result: SuggestedActionsResult
) -> None:
    """Apply ``actions`` (decision id -> cut / shorten / lower / leave) to ``project`` in place.

    The caller owns the transaction, so a service call and a pipeline step each get one
    undo step.  Lowers go first (a laugh nobody talks over becomes a leave), then leaves,
    then every cut together so the speech guard sees one batch.
    """
    from podcast_mcp.edits.decisions import (
        HeldEdit,
        approve_edits,
        reject_edits,
        unplayed_pending_ids,
    )
    from podcast_mcp.edits.source_removals import record_suggested_cut_speech

    by_id = {e.id: e for e in project.edit_decisions}
    cut_ids = [i for i, a in actions.items() if a in ("cut", "shorten") and i in by_id]
    done: set[str] = set()
    for edit_id in [i for i, a in actions.items() if a == "lower" and i in by_id]:
        decision = by_id[edit_id]
        if not another_speaker_over(project, decision):
            actions[edit_id] = "leave"
            result.left_no_overlap += 1
        elif apply_lower(project, decision):
            done.add(edit_id)
            result.applied["lower"] = result.applied.get("lower", 0) + 1
        else:
            result.held.append(edit_id)
    leave_ids = [i for i, a in actions.items() if a == "leave" and i in by_id]
    reject_edits(project, leave_ids)
    if leave_ids:
        result.applied["leave"] = len(leave_ids)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in done]
    if not cut_ids:
        return
    before = {e.id for e in project.edit_decisions}
    stale = unplayed_pending_ids(project, set(cut_ids))
    live = [i for i in cut_ids if i not in stale]
    for edit_id in live:
        decision = by_id[edit_id]
        if decision.scope != "track" and decision.exact_range is None:
            record_suggested_cut_speech(project, decision)
    over = {i for i in live if by_id[i].cut_speech is not None}
    held: list[HeldEdit] = []
    overridden: set[str] = set()
    approve_edits(
        project,
        live,
        confirm_cut_speech=True,
        allow_review=False,
        held_out=held,
        override_peer_holds=overridden,
        accept_leaned_on=True,
    )
    gone = before - {e.id for e in project.edit_decisions}
    applied_cuts = [i for i in cut_ids if i in gone]
    for action in ("cut", "shorten"):
        n = sum(1 for i in applied_cuts if actions[i] == action)
        if n:
            result.applied[action] = n
    result.cut_over_speaker = len((over | overridden) & set(applied_cuts))
    result.held.extend(h.edit_id for h in held)
    result.held.extend(i for i in cut_ids if i not in gone and i not in result.held)
