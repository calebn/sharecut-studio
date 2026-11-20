from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Literal

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.cut_placement import CutScopeHold, inspect_source_remove_placement
from podcast_mcp.edits.cut_safety import hold_is_overridable, inspect_source_remove
from podcast_mcp.edits.cut_speech import assess_cut_speech
from podcast_mcp.edits.ripple import RippleRemoval
from podcast_mcp.edits.tighten_reasons import is_pause_reason
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
from podcast_mcp.util.coded_error import CodedError, guest_message_for_code
from podcast_mcp.util.redact import mentions_host_path
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
    "late_mpeg_audio": (
        "a recording starts late in an MPEG stream; re-encode it and re-add it as a track"
    ),
    "mid_word": "the cut lands inside a word",
    "breath_edge": "the cut lands on a breath",
}


PLAIN_HOLD_REASONS: Mapping[str, str] = {
    "acoustic_edge": "the edit would start or end inside a word or a breath, and that could be heard",
    "source_geometry": "that part of the recording is no longer in one piece on the timeline",
    "stored_track_pause": "a pause can only be shortened for the whole recording, not for one speaker",
    "speaker_bleed": "that sound is another speaker's voice on this microphone",
    "scope_unavailable": "the other speakers' audio could not be checked",
    "media_extent_unavailable": "the full recording is not available right now",
    "operation_scope": "other audio plays inside it that this edit would not remove",
    "pause_not_shorter": "it would not make the pause any shorter",
    "pause_imperceptible": "it would shorten the pause too little to hear",
    "pause_air": "it could not keep enough quiet room sound in the pause",
    "pause_join": "the pause would sound abrupt where it joins",
}
_UNNAMED_EDIT = "That edit"
PEER_SPEECH_PLAIN = "someone else is speaking there and would be cut off"
GENERIC_HOLD_REASON = "it could not be applied"
_GUEST_HOLD_CODES: Mapping[str, str] = {
    **PLAIN_HOLD_REASONS,
    "peer_speech": PEER_SPEECH_PLAIN,
    "stale": "its audio was already cut away, so it no longer plays",
    "waits_with_held": "it sits right beside a held cut, so it waits with it",
    "unsure_word": "it has a word the transcript is not sure of",
}
_UNNAMED_PEER = "someone else"


def guest_hold_reason(code: str, reason: str) -> str:
    """A held row's reason as a guest reads it: one path-free sentence, never empty."""
    plain = _GUEST_HOLD_CODES.get(code) or _GUEST_HOLD_CODES.get(reason)
    return plain if plain and not mentions_host_path(plain) else GENERIC_HOLD_REASON


def _lane_problem(lane: LaneUnavailable, name: str) -> str:
    cause = lane.cause if isinstance(lane.cause, str) else lane.cause.cause
    return f"{name} {_LANE_PROBLEMS.get(cause, _UNCHECKED_LANE)}"


STALE_REASON = "its audio was already cut away, so it no longer plays"


def cut_label(project: EpisodeProject, edit: EditDecision) -> str:
    """People's name for a pending cut: whose, what kind and where in the recording."""
    speakers = speakers_by_track(project)
    if edit.exact_range is not None:
        who = " and ".join(speakers.get(tid, tid) for tid in edit.exact_range.track_ids)
        kind = "mute" if edit.type is EditDecisionType.MUTE else "cut"
    else:
        who = speakers.get(edit.track_id, edit.track_id)
        kind = "pause trim" if is_pause_reason(edit.reason) else "cut"
    return f"{who}'s {kind} at {clock_label(edit.start)}"


def removal_label(project: EpisodeProject, removal: RippleRemoval | None) -> str | None:
    """People's name for a range cut with no pending edit: whose and where, or None unnamed."""
    if removal is None or not removal.selected:
        return None
    speakers = speakers_by_track(project)
    who = " and ".join(
        dict.fromkeys(speakers.get(e.track_id, e.track_id) for e in removal.selected)
    )
    return f"{who}'s cut at {clock_label(min(e.start for e in removal.selected))}"


def speakers_by_track(project: EpisodeProject) -> dict[str, str]:
    return {t.id: t.speaker or t.label or t.id for t in project.tracks}


def plain_label(label: str | None) -> str:
    """A cut's name as a sentence start; a name that looks like a path is withheld."""
    if not label or mentions_host_path(label):
        return _UNNAMED_EDIT
    return label[:1].upper() + label[1:]


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

    @classmethod
    def for_project(
        cls,
        project: EpisodeProject,
        held: Sequence[CutScopeHold],
        edits: Iterable[EditDecision] = (),
        removal: RippleRemoval | None = None,
    ) -> ScopeChangedAtApproval:
        cuts = {e.id: cut_label(project, e) for e in edits}
        named = removal_label(project, removal)
        if named is not None:
            cuts.update({h.edit_id: named for h in held})
        return cls(held, speakers_by_track(project), cuts)

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
        return why + self._lane_suffix(hold)

    def _lane_suffix(self, hold: CutScopeHold) -> str:
        if not hold.unavailable_lanes:
            return ""
        problems = "; ".join(
            _lane_problem(lane, self.speakers.get(lane.track_id, lane.track_id))
            for lane in hold.unavailable_lanes
        )
        return f" ({problems})"

    def plain_reason_for(self, hold: CutScopeHold) -> str:
        if hold.reason == "peer_speech":
            names = [self.speakers.get(peer, _UNNAMED_PEER) for peer in hold.peers]
            names = [_UNNAMED_PEER if mentions_host_path(n) else n for n in names]
            who = " and ".join(dict.fromkeys(names)) or _UNNAMED_PEER
            verb = "are" if len(set(names)) > 1 else "is"
            why = f"{who} {verb} speaking there and would be cut off"
        else:
            why = PLAIN_HOLD_REASONS[hold.reason]
        return why + self._lane_suffix(hold)

    def guest_message(self) -> str:
        sentences = dict.fromkeys(
            f"{plain_label(self.cuts.get(hold.edit_id))} was not applied because "
            f"{self.plain_reason_for(hold)}."
            for hold in self.held
        )
        message = " ".join([*sentences, "Nothing was changed."])
        return guest_message_for_code(self.code) if mentions_host_path(message) else message

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
