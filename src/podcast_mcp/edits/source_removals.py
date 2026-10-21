from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Literal

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.cut_placement import CutScopeHold
from podcast_mcp.edits.cut_safety import hold_is_overridable, inspect_source_remove
from podcast_mcp.edits.cut_speech import assess_cut_speech
from podcast_mcp.edits.timeline_ops import (
    LaneUnavailable,
    plan_ripple_delete,
)
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    EpisodeProject,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.timebase import clock_label

_PAD_EDGE_MATCH_SEC = 0.05
_SOURCE_GEOMETRY_TOLERANCE_SEC = 1e-6


_LANE_PROBLEMS = {
    "media_extent_unavailable": "has a recording whose length is unknown",
    "implicit_playback_with_parked_source": "plays audio the cut cannot measure",
    "effect_media_unavailable": "has audio the join check could not read",
    "effect_source_geometry": "does not play as one continuous piece at the join",
    "unsafe_inherited_fade": "has a fade at the join that is too long to keep",
}
_UNCHECKED_LANE = "could not be checked"
_SELECT_OR_REJECT = "Select the part to cut on the timeline, or reject the held cuts."
_APPLY_ANYWAY = (
    "To apply it as is, repeat the call with the audio-check override "
    "(CLI --override-audio-checks, MCP override_audio_checks=true)."
)
_EDGE_FINDINGS = {
    "join_continuity": "the join would be audible",
    "review_required": "the join needs a listen",
    "audio_unavailable": "the audio could not be read",
    "mid_word": "the cut lands inside a word",
    "breath_edge": "the cut lands on a breath",
}


def _lane_problem(lane: LaneUnavailable, speakers: Mapping[str, str]) -> str:
    cause = lane.cause if isinstance(lane.cause, str) else lane.cause.cause
    return (
        f"{speakers.get(lane.track_id, lane.track_id)} {_LANE_PROBLEMS.get(cause, _UNCHECKED_LANE)}"
    )


STALE_REASON = "its audio was already cut away, so it no longer plays"


def cut_label(project: EpisodeProject, edit: EditDecision) -> str:
    """People's name for a pending cut: whose, what kind and where in the recording."""
    track = project.track_by_id(edit.track_id)
    who = (track.speaker or track.label or track.id) if track else edit.track_id
    kind = "pause trim" if (edit.reason or "").startswith("pause:") else "cut"
    return f"{who}'s {kind} at {clock_label(edit.start)}"


class ScopeChangedAtApproval(CodedError, ValueError):
    code = "cut_scope_changed"

    def __init__(
        self,
        held: Sequence[CutScopeHold],
        speakers: dict[str, str],
        cuts: Mapping[str, str] | None = None,
    ):
        self.ids = tuple(h.edit_id for h in held)
        self.held = tuple(held)
        self.speakers = speakers
        self.cuts = dict(cuts or {})
        details = []
        for hold in held:
            label = self.cuts.get(hold.edit_id, "A selected cut")
            details.append(f"{label} was not applied because {self.reason_for(hold)}.")
        hint = [_APPLY_ANYWAY] if any(hold_is_overridable(h) for h in held) else []
        super().__init__(" ".join([*details, _SELECT_OR_REJECT, *hint]))

    def reason_for(self, hold: CutScopeHold) -> str:
        """Why this one cut was held, in words the list can show beside it."""
        reasons = {
            "source_geometry": "the selected audio no longer has one complete, continuous placement",
            "stored_track_pause": "a pause must shorten the session and cannot silence only one track",
            "speaker_bleed": "the selected audio is another speaker's bleed",
            "scope_unavailable": "the other tracks could not be checked",
            "media_extent_unavailable": "the full recording duration is unavailable",
            "operation_scope": "the selected audio plays outside the tracks this cut removes",
            "pause_not_shorter": "the replacement pad would leave the pause as long or longer",
            "pause_imperceptible": "the pause would shorten too little to hear",
            "pause_air": "the pause cannot retain enough original quiet audio safely",
            "pause_join": "the final pause join did not pass its audio checks",
            "acoustic_edge": "the held edges need audio review",
        }
        if hold.reason == "acoustic_edge" and hold.detail:
            findings = [
                _EDGE_FINDINGS.get(label, label.replace("_", " "))
                for label in dict.fromkeys(hold.detail.split(","))
            ]
            return f"{reasons['acoustic_edge']} ({'; '.join(findings)})"
        peers = ", ".join(self.speakers.get(peer, peer) for peer in hold.peers)
        why = reasons.get(
            hold.reason,
            f"{peers or 'another track'} is speaking where the session cut would remove it",
        )
        if hold.unavailable_lanes:
            problems = "; ".join(
                _lane_problem(lane, self.speakers) for lane in hold.unavailable_lanes
            )
            why += f" ({problems})"
        return why

    def for_delivery(self, delivery: Literal["saved", "suggested"]) -> ScopeChangedAtApproval:
        error = ScopeChangedAtApproval(self.held, self.speakers, self.cuts)
        suffix = (
            " None of the selected edits were applied."
            if delivery == "saved"
            else " Suggested preview is unavailable. The saved project is unchanged."
        )
        error.args = (str(error) + suffix,)
        return error


def resize_source_remove(
    project: EpisodeProject, saved: EditDecision, *, start: float, end: float
) -> EditDecision:
    from podcast_mcp.edits.cut_placement import inspect_source_remove_placement

    current = inspect_source_remove_placement(project, saved)
    if isinstance(current, CutScopeHold):
        raise ScopeChangedAtApproval([current], {}, {saved.id: cut_label(project, saved)})
    candidate = saved.model_copy(deep=True, update={"start": start, "end": end})
    placement = inspect_source_remove_placement(project, candidate, check_witness=False)
    if isinstance(placement, CutScopeHold):
        raise ScopeChangedAtApproval([placement], {}, {saved.id: cut_label(project, saved)})
    expected_start = float(current[0]) + (start - saved.start)
    expected_end = float(current[1]) + (end - saved.end)
    if (
        abs(float(placement[0]) - expected_start) > 1e-6
        or abs(float(placement[1]) - expected_end) > 1e-6
    ):
        hold = CutScopeHold(saved.id, (), "source_geometry")
        raise ScopeChangedAtApproval([hold], {}, {saved.id: cut_label(project, saved)})
    candidate.source_timeline_span = RangeInterval(
        start=float(placement[0]), end=float(placement[1])
    )
    return candidate


def require_source_remove(
    project: EpisodeProject, edit: EditDecision, *, heard_pause_sec: float | None = None
) -> None:
    if edit.type != EditDecisionType.REMOVE or edit.exact_range is not None or edit.applied:
        return
    assessment = inspect_source_remove(project, edit, heard_pause_sec=heard_pause_sec)
    if isinstance(assessment, CutScopeHold):
        raise ScopeChangedAtApproval([assessment], {}, {edit.id: cut_label(project, edit)})


def record_suggested_cut_speech(
    project: EpisodeProject, decision: EditDecision, *, defaults: EffectiveConfig
) -> None:
    """Record on a suggested session ripple the other speech it would cut.

    Programmatic approval holds that speech for trusted interactive review
    as changed.
    """
    if decision.type != EditDecisionType.REMOVE:
        return
    from podcast_mcp.edits.cut_placement import inspect_source_remove_placement

    span = inspect_source_remove_placement(project, decision)
    if isinstance(span, CutScopeHold):
        return
    decision.cut_speech = assess_cut_speech(
        project,
        plan_ripple_delete(
            project,
            float(span[0]),
            float(span[1]),
            edited_track_ids=[decision.track_id],
            use_inaudible_opt=False,
            defaults=defaults,
        ),
        defaults=defaults,
    )
