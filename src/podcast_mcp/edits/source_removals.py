from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from itertools import pairwise
from typing import Literal

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    SourceExtent,
    assess_cut_speech,
    clear_ripple,
)
from podcast_mcp.edits.filler_pacing import filler_pad_mode, pause_trim_is_imperceptible
from podcast_mcp.edits.inaudible_cuts import (
    optimize_timeline_cut_range,
)
from podcast_mcp.edits.ripple import ripple_track_ids
from podcast_mcp.edits.timeline_ops import (
    LaneUnavailable,
    insert_gap,
    insert_room_tone_pad,
    plan_ripple_delete,
    punch_delete,
    ripple_delete,
)
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_plays_lane,
    clip_timeline_overlap_to_source,
    origin_track_id_for_clip,
)
from podcast_mcp.models import (
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.util.batch_scope import frozen_state
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec, TimelineSec, clock_label
from podcast_mcp.util.tracks import dialogue_track_ids, recording_audio_path

_PAD_EDGE_MATCH_SEC = 0.05
_SOURCE_GEOMETRY_TOLERANCE_SEC = 1e-6


@dataclass(frozen=True)
class CutScopeHold:
    edit_id: str
    peers: tuple[str, ...]
    reason: Literal[
        "peer_speech",
        "source_geometry",
        "stored_track_pause",
        "speaker_bleed",
        "scope_unavailable",
        "pause_not_shorter",
        "pause_imperceptible",
        "media_extent_unavailable",
        "operation_scope",
        "pause_air",
        "pause_join",
    ] = "peer_speech"
    unavailable_lanes: tuple[LaneUnavailable, ...] = ()
    detail: str | None = None


_LANE_PROBLEMS = {
    "media_extent_unavailable": "has a recording whose length is unknown",
    "implicit_playback_with_parked_source": "plays audio the cut cannot measure",
    "effect_media_unavailable": "has audio the join check could not read",
    "effect_source_geometry": "does not play as one continuous piece at the join",
    "unsafe_inherited_fade": "has a fade at the join that is too long to keep",
}
_UNCHECKED_LANE = "could not be checked"
_SELECT_OR_REJECT = "Select the part to cut on the timeline, or reject the held cuts."


def _lane_problem(lane: LaneUnavailable, speakers: Mapping[str, str]) -> str:
    cause = lane.cause if isinstance(lane.cause, str) else lane.cause.cause
    return (
        f"{speakers.get(lane.track_id, lane.track_id)} {_LANE_PROBLEMS.get(cause, _UNCHECKED_LANE)}"
    )


def _source_remove_lanes(
    project: EpisodeProject,
    timeline: SessionTimeline,
    edit: EditDecision,
    start: TimelineSec,
    end: TimelineSec,
) -> frozenset[str]:
    if edit.source_timeline_span is not None:
        source_ids = project.equivalent_source_ids(edit.track_id, edit.source_id)
        selected = frozenset(
            clip.track_id
            for clip in project.clips
            if clip.source_id in source_ids
            and clip_plays_lane(project, clip, edit.track_id)
            and min(float(end), clip.timeline_end) > max(float(start), clip.timeline_start) + 1e-9
        )
        if selected:
            return selected
    return timeline.origin_placement_lanes(edit.track_id, start, end)


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
        super().__init__(" ".join([*details, _SELECT_OR_REJECT]))

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
        }
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


def inspect_source_remove_placement(
    project: EpisodeProject, edit: EditDecision
) -> tuple[TimelineSec, TimelineSec] | CutScopeHold:
    """Check complete source placement and canonical operation membership."""
    return _inspect_source_remove_placement(project, edit, check_witness=True)


def resize_source_remove(
    project: EpisodeProject, saved: EditDecision, *, start: float, end: float
) -> EditDecision:
    current = inspect_source_remove_placement(project, saved)
    if isinstance(current, CutScopeHold):
        raise ScopeChangedAtApproval([current], {}, {saved.id: cut_label(project, saved)})
    candidate = saved.model_copy(deep=True, update={"start": start, "end": end})
    placement = _inspect_source_remove_placement(project, candidate, check_witness=False)
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


def _inspect_source_remove_placement(
    project: EpisodeProject, edit: EditDecision, *, check_witness: bool
) -> tuple[TimelineSec, TimelineSec] | CutScopeHold:
    if (
        edit.type != EditDecisionType.REMOVE
        or edit.exact_range is not None
        or edit.timebase != "source"
    ):
        raise ValueError("ordinary source remove required")
    pause = (edit.reason or "").startswith("pause:")
    if pause and edit.scope == "track":
        return CutScopeHold(edit.id, (), "stored_track_pause")
    timeline = SessionTimeline(project)
    span: tuple[TimelineSec, TimelineSec] | None
    if edit.source_timeline_span is not None:
        lane_clips = [c for c in project.clips if clip_plays_lane(project, c, edit.track_id)]
        if lane_clips:
            spans = timeline.map_placements_source_span(
                edit.track_id,
                project.equivalent_source_ids(edit.track_id, edit.source_id),
                SourceSec(edit.start),
                SourceSec(edit.end),
            )
        elif None in project.equivalent_source_ids(edit.track_id, edit.source_id):
            spans = timeline.map_source_span(
                edit.track_id, SourceSec(edit.start), SourceSec(edit.end)
            )
        else:
            spans = []
        expected = edit.source_timeline_span
        if (
            len(spans) != 1
            or abs(float(spans[0][1] - spans[0][0]) - (edit.end - edit.start)) > 1e-6
            or (
                check_witness
                and expected is not None
                and (
                    abs(float(spans[0][0]) - expected.start) > 1e-6
                    or abs(float(spans[0][1]) - expected.end) > 1e-6
                )
            )
        ):
            return CutScopeHold(edit.id, (), "source_geometry")
        span = (
            (TimelineSec(expected.start), TimelineSec(expected.end))
            if check_witness and expected is not None
            else (spans[0][0], spans[0][1])
        )
        if _witnessed_source_span_has_unsafe_overlap(project, edit, *span):
            return CutScopeHold(edit.id, (), "source_geometry")
    else:
        if edit.source_id is not None:
            return CutScopeHold(edit.id, (), "source_geometry")
        span = timeline.exact_source_span(edit.track_id, SourceSec(edit.start), SourceSec(edit.end))
    if span is None or (
        edit.source_timeline_span is None
        and timeline.exact_timeline_source_span(
            edit.track_id,
            *span,
            on_origin_lane=edit.scope == "track",
        )
        is None
    ):
        track = project.track_by_id(edit.track_id)
        if (
            track
            and track.media
            and not track.timeline_empty
            and not any(
                c.track_id == edit.track_id or origin_track_id_for_clip(project, c) == edit.track_id
                for c in project.clips
            )
            and (track.media.duration_sec is None or not math.isfinite(track.media.duration_sec))
        ):
            return CutScopeHold(edit.id, (), "media_extent_unavailable")
        return CutScopeHold(edit.id, (), "source_geometry")
    lanes = _source_remove_lanes(project, timeline, edit, *span)
    allowed = (
        {edit.track_id}
        if edit.scope == "track"
        else set(ripple_track_ids(project, [edit.track_id]))
    )
    if not lanes or not lanes <= allowed:
        return CutScopeHold(edit.id, (), "operation_scope")
    return span


def _witnessed_source_span_has_unsafe_overlap(
    project: EpisodeProject,
    edit: EditDecision,
    start: TimelineSec,
    end: TimelineSec,
) -> bool:
    source_ids = project.equivalent_source_ids(edit.track_id, edit.source_id)
    lo_window, hi_window = float(start), float(end)
    selected_pieces = []
    for clip in project.clips:
        lo = max(lo_window, clip.timeline_start)
        hi = min(hi_window, clip.timeline_end)
        if (
            hi <= lo + _SOURCE_GEOMETRY_TOLERANCE_SEC
            or clip.source_id not in source_ids
            or not clip_plays_lane(project, clip, edit.track_id)
        ):
            continue
        selected_pieces.append((clip, lo, hi))

    selected_lanes = {clip.track_id for clip, _, _ in selected_pieces}
    protected_lanes = selected_lanes | {edit.track_id}
    for clip in project.clips:
        if clip.track_id not in protected_lanes:
            continue
        lo = max(lo_window, clip.timeline_start)
        hi = min(hi_window, clip.timeline_end)
        if hi <= lo + _SOURCE_GEOMETRY_TOLERANCE_SEC:
            continue
        if clip.source_id not in source_ids or not clip_plays_lane(project, clip, edit.track_id):
            return True
        expected_lo = edit.start + (lo - lo_window)
        expected_hi = edit.start + (hi - lo_window)
        actual = clip_timeline_overlap_to_source(clip, lo, hi)
        if actual is None:
            return True
        actual_lo, actual_hi = actual
        if (
            abs(actual_lo - expected_lo) > _SOURCE_GEOMETRY_TOLERANCE_SEC
            or abs(actual_hi - expected_hi) > _SOURCE_GEOMETRY_TOLERANCE_SEC
        ):
            return True

    if not selected_pieces:
        return False
    boundaries = sorted(
        {
            lo_window,
            hi_window,
            *(lo for _, lo, _ in selected_pieces),
            *(hi for _, _, hi in selected_pieces),
        }
    )
    for left, right in pairwise(boundaries):
        if right <= left + _SOURCE_GEOMETRY_TOLERANCE_SEC:
            continue
        covering = [
            clip
            for clip, lo, hi in selected_pieces
            if lo <= left + _SOURCE_GEOMETRY_TOLERANCE_SEC
            and hi >= right - _SOURCE_GEOMETRY_TOLERANCE_SEC
        ]
        if len(covering) != 1:
            return True
    return False


def inspect_source_remove(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    heard_pause_sec: float | None = None,
    audio_caches: Mapping[str, TrackAudioCache] | None = None,
) -> tuple[float, float] | CutScopeHold:
    """Assess final ordinary SOURCE bounds without publishing or authorizing a later mutation."""
    span = inspect_source_remove_placement(project, edit)
    if isinstance(span, CutScopeHold):
        return span
    if (edit.reason or "").startswith("pause:"):
        timeline = SessionTimeline(project)
        loss = float(span[1] - span[0]) - (edit.replace_gap_sec or 0.0)
        if loss <= 0:
            return CutScopeHold(edit.id, (), "pause_not_shorter")
        heard = heard_pause_sec
        if heard is None:
            from podcast_mcp.edits.session_air import SessionAir

            heard = SessionAir(project, audio_caches=audio_caches or {}).silence_around(
                float(span[0]), float(span[1])
            )
        if heard is None:
            transcript = project.transcript_for_track(edit.track_id)
            words = (
                [w for w in transcript.words if not w.suppressed and not w.ignored]
                if transcript
                else []
            )
            before = max((w.end for w in words if w.end <= edit.start), default=None)
            after = min((w.start for w in words if w.start >= edit.end), default=None)
            if before is not None and after is not None:
                heard = sum(
                    float(e - s)
                    for s, e in timeline.map_source_span(
                        edit.track_id, SourceSec(before), SourceSec(after)
                    )
                )
            else:
                heard = float(span[1] - span[0])
        if pause_trim_is_imperceptible(loss, heard):
            return CutScopeHold(edit.id, (), "pause_imperceptible")
    return float(span[0]), float(span[1])


def require_source_remove(
    project: EpisodeProject, edit: EditDecision, *, heard_pause_sec: float | None = None
) -> None:
    if edit.type != EditDecisionType.REMOVE or edit.exact_range is not None or edit.applied:
        return
    assessment = inspect_source_remove(project, edit, heard_pause_sec=heard_pause_sec)
    if isinstance(assessment, CutScopeHold):
        raise ScopeChangedAtApproval([assessment], {}, {edit.id: cut_label(project, edit)})


def record_suggested_cut_speech(project: EpisodeProject, decision: EditDecision) -> None:
    """Record on a suggested session ripple the other speech it would cut.

    Approval then asks to confirm that speech (Cut anyway) instead of holding the cut
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
        ),
    )


def _nearest_ripple_join_time(project: EpisodeProject, near_sec: float) -> float:
    best: float | None = None
    best_dist = float("inf")
    for tid in dialogue_track_ids(project):
        clips = clips_for_track(project, tid)
        for i in range(len(clips) - 1):
            left, right = clips[i], clips[i + 1]
            if abs(left.timeline_end - right.timeline_start) > 1e-3:
                continue
            dist = abs(left.timeline_end - near_sec)
            if dist < best_dist:
                best_dist = dist
                best = left.timeline_end
    return best if best is not None and best_dist < 0.1 else near_sec


def _pending_playing_source_spans(
    project: EpisodeProject, besides: EditDecision
) -> dict[str, list[tuple[float, float]]]:
    timeline = SessionTimeline(project)
    spans: dict[str, list[tuple[float, float]]] = {}
    for other in project.edit_decisions:
        if (
            other.id == besides.id
            or other.applied
            or other.exact_range is not None
            or other.type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE)
            or not timeline.map_source_span(
                other.track_id, SourceSec(other.start), SourceSec(other.end)
            )
        ):
            continue
        spans.setdefault(other.track_id, []).append((other.start, other.end))
    return spans


def _apply_replace_gap_pad(
    project: EpisodeProject,
    edit: EditDecision,
    tl_start: float,
    *,
    exact_seam: bool = False,
    source_audio_caches: Mapping[str, TrackAudioCache] | None = None,
) -> list[dict]:
    gap = edit.replace_gap_sec
    if gap is None or gap <= 0:
        return []
    if getattr(edit, "scope", "session") == "track":
        return []
    pad_start_sec = (
        tl_start
        if exact_seam or (edit.reason or "").startswith("pause:")
        else _nearest_ripple_join_time(project, tl_start)
    )
    if filler_pad_mode() == "room_tone":
        report = insert_room_tone_pad(
            project, pad_start_sec, gap, avoid=_pending_playing_source_spans(project, edit)
        )
        samples = report["pad_samples"]
    else:
        insert_gap(project, pad_start_sec, gap)
        samples = []
    defaults = load_defaults()
    left_pad_fade_out_ms = int(defaults.get("tighten", {}).get("filler_pre_pad_fade_out_ms", 5))
    for tid in dialogue_track_ids(project):
        for clip in clips_for_track(project, tid):
            if abs(clip.timeline_end - pad_start_sec) <= _PAD_EDGE_MATCH_SEC:
                clip.fade_out_ms = left_pad_fade_out_ms
                clip.join_in_mode = ClipJoinMode.FADE
    right_pad_edge_sec = pad_start_sec + gap
    for tid in dialogue_track_ids(project):
        for clip in clips_for_track(project, tid):
            if abs(clip.timeline_start - right_pad_edge_sec) <= _PAD_EDGE_MATCH_SEC:
                cache = (source_audio_caches or {}).get(tid)
                right_pad_fade_in_ms = recommend_post_pad_fade_in_ms(
                    project,
                    tid,
                    clip.source_start,
                    next_burst_sec=edit.next_burst_sec,
                    defaults=defaults,
                    audio_cache=cache,
                )
                if right_pad_fade_in_ms > 0:
                    clip.fade_in_ms = max(int(clip.fade_in_ms), right_pad_fade_in_ms)
                    clip.join_in_mode = ClipJoinMode.FADE
    return samples


def consume_source_remove(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    confirm_cut_speech: bool,
    allow_review: bool,
    batch: Sequence[SourceExtent],
    use_inaudible_opt: bool | None = False,
    record_log: bool = False,
    override_peer_holds: set[str] | None = None,
) -> tuple[float, float, list[str], dict] | CutSpeechConfirmation | CutScopeHold:
    """Prove and consume the actual ordinary source removal against current playback.

    With ``override_peer_holds`` a cut the speech guard would hold for another track's
    speech or bleed (``peer_speech`` / ``speaker_bleed``) applies as the session ripple
    over every dialogue track instead, and its id is added to the set. Every other hold
    still holds.

    The proof only reads the project, so its repeated reads (a track's render hash, once per
    peer window) share the first result until the first mutation.
    """
    with ExitStack() as proof:
        proof.enter_context(frozen_state())
        return _consume_source_remove(
            project,
            edit,
            proof=proof,
            confirm_cut_speech=confirm_cut_speech,
            allow_review=allow_review,
            batch=batch,
            use_inaudible_opt=use_inaudible_opt,
            record_log=record_log,
            override_peer_holds=override_peer_holds,
        )


def _consume_source_remove(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    proof: ExitStack,
    confirm_cut_speech: bool,
    allow_review: bool,
    batch: Sequence[SourceExtent],
    use_inaudible_opt: bool | None,
    record_log: bool,
    override_peer_holds: set[str] | None = None,
) -> tuple[float, float, list[str], dict] | CutSpeechConfirmation | CutScopeHold:
    """Prove and consume the actual ordinary source removal against current playback.

    A stored peer-speech review retains its confirmation path; fresh bleed or unavailable
    scope still holds. A hold changes no geometry. Generic witnessed cuts keep their
    proven window through consumption; pause trims re-prove their optimized window.
    """
    from podcast_mcp.edits.cut_proof import shared_source_audio_caches, shared_timeline_rms_caches
    from podcast_mcp.edits.speech_energy_guard import CutScopeUnavailable, resolve_cut_scope
    from podcast_mcp.edits.track_media import full_span_clip

    timeline_caches = shared_timeline_rms_caches(project)
    source_audio_caches = shared_source_audio_caches(project)

    scope = edit.scope or "session"
    seed = inspect_source_remove_placement(project, edit)
    if isinstance(seed, CutScopeHold):
        return seed
    timeline = SessionTimeline(project)
    tl_start, tl_end = float(seed[0]), float(seed[1])
    removal = None
    prepared_pause = None
    actual = edit
    pause = (edit.reason or "").startswith("pause:")
    witnessed = edit.source_timeline_span is not None
    consumed_inaudible_opt = use_inaudible_opt if pause or not witnessed else False
    if pause:
        from podcast_mcp.edits.fillers import (
            _CutRejected,
            _finish_candidate,
            _prepare_pending_pause,
        )
        from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent

        defaults = load_defaults()
        preparation = _prepare_pending_pause(
            project, edit, defaults, force_enabled=use_inaudible_opt
        )
        if isinstance(preparation, _CutRejected):
            reason: Literal[
                "pause_imperceptible",
                "pause_not_shorter",
                "source_geometry",
                "scope_unavailable",
                "pause_air",
            ] = (
                "pause_imperceptible"
                if preparation.skip == "imperceptible"
                else "pause_not_shorter"
                if preparation.skip == "pause_not_shorter"
                else "source_geometry"
                if preparation.skip == "source_geometry"
                else "scope_unavailable"
                if preparation.skip == "scope_unavailable"
                else "pause_air"
            )
            return CutScopeHold(
                edit.id,
                tuple(lane.track_id for lane in preparation.unavailable_lanes),
                reason,
                preparation.unavailable_lanes,
                preparation.skip,
            )
        prepared_pause = preparation
        finished = _finish_candidate(project, prepared_pause, defaults)
        if isinstance(finished, _CutRejected):
            return CutScopeHold(edit.id, (), "pause_join", detail=finished.skip)
        if prepared_pause.peer_observation_span is not None and (
            finished.start != prepared_pause.plan.start or finished.end != prepared_pause.plan.end
        ):
            return CutScopeHold(edit.id, (), "source_geometry")
        if finished.review_required and not allow_review:
            return CutScopeHold(edit.id, (), "pause_join", detail="review_required")
        actual = edit.model_copy(
            update={
                "start": finished.start,
                "end": finished.end,
                "replace_gap_sec": finished.replace_gap_sec,
                "next_burst_sec": finished.next_burst_sec or edit.next_burst_sec,
                "crossfade_ms": finished.crossfade_ms,
            }
        )
        final_span = inspect_source_remove_placement(project, actual)
        if isinstance(final_span, CutScopeHold):
            return final_span
        tl_start, tl_end = float(final_span[0]), float(final_span[1])
        removal = RippleRemoval.of([TrackExtent(edit.track_id, tl_start, tl_end)])
    elif scope == "track":
        if not witnessed:
            opt = optimize_timeline_cut_range(
                project, edit.track_id, tl_start, tl_end, force_enabled=use_inaudible_opt
            )
            tl_start, tl_end = opt.start, opt.end
    else:
        if witnessed:
            from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent

            removal = RippleRemoval.of(
                [TrackExtent(edit.track_id, tl_start, tl_end)],
                unselected=[(tl_start, tl_end)],
            )
        else:
            removal = plan_ripple_delete(
                project,
                tl_start,
                tl_end,
                edited_track_ids=[edit.track_id],
                use_inaudible_opt=consumed_inaudible_opt,
            )
        if len(removal.spans) != 1:
            return CutScopeHold(edit.id, (), "source_geometry")
        tl_start, tl_end = removal.spans[0]
    if (
        witnessed
        and not pause
        and (
            abs(tl_start - float(seed[0])) > _SOURCE_GEOMETRY_TOLERANCE_SEC
            or abs(tl_end - float(seed[1])) > _SOURCE_GEOMETRY_TOLERANCE_SEC
        )
    ):
        return CutScopeHold(edit.id, (), "source_geometry")
    source = (
        (SourceSec(actual.start), SourceSec(actual.end))
        if edit.source_timeline_span is not None
        else SessionTimeline(project).exact_timeline_source_span(
            edit.track_id,
            TimelineSec(tl_start),
            TimelineSec(tl_end),
            on_origin_lane=scope == "track",
        )
    )
    if source is None:
        return CutScopeHold(edit.id, (), "source_geometry")
    tracks = (
        [edit.track_id] if removal is None else ripple_track_ids(project, removal.edited_track_ids)
    )
    lanes = _source_remove_lanes(
        project, timeline, edit, TimelineSec(tl_start), TimelineSec(tl_end)
    )
    if not lanes or not lanes <= set(tracks):
        return CutScopeHold(edit.id, (), "operation_scope")
    actual = actual.model_copy(update={"start": float(source[0]), "end": float(source[1])})
    assessed = inspect_source_remove(
        project,
        actual,
        heard_pause_sec=prepared_pause.heard_pause if prepared_pause else None,
        audio_caches=source_audio_caches,
    )
    if isinstance(assessed, CutScopeHold):
        return assessed
    if scope != "track":
        mapped_spans = (
            ((edit.source_timeline_span.start, edit.source_timeline_span.end),)
            if edit.source_timeline_span is not None
            else tuple(
                (float(start), float(end))
                for start, end in timeline.map_source_span(
                    edit.track_id, SourceSec(actual.start), SourceSec(actual.end)
                )
            )
        )
        admissible_spans = mapped_spans if not pause else None
        if prepared_pause is not None and prepared_pause.peer_observation_span is not None:
            observed_start, observed_end = prepared_pause.peer_observation_span
            if not mapped_spans or any(
                not observed_start <= start < end <= observed_end for start, end in mapped_spans
            ):
                return CutScopeHold(edit.id, (), "source_geometry")
            admissible_spans = mapped_spans
        try:
            resolved = resolve_cut_scope(
                project,
                edit.track_id,
                actual.start,
                actual.end,
                requested_scope=scope,
                defaults=load_defaults(),
                caches=timeline_caches,
                _admissible_spans=admissible_spans,
            )
        except ValueError as blocked:
            peers = tuple(getattr(blocked, "peers", ()))
            return CutScopeHold(edit.id, peers, "peer_speech" if peers else "scope_unavailable")
        if isinstance(resolved, CutScopeUnavailable):
            return CutScopeHold(edit.id, (), "scope_unavailable")
        if resolved.scope == "track":
            peers = resolved.guard.blocking_track_ids if resolved.guard else ()
            hold: Literal["speaker_bleed", "peer_speech"] | None = (
                "speaker_bleed"
                if resolved.cause == "speaker_bleed"
                else "peer_speech"
                if resolved.cause == "peer_speech" and edit.cut_speech is None
                else None
            )
            if hold is not None:
                if override_peer_holds is None:
                    return CutScopeHold(edit.id, peers, hold)
                override_peer_holds.add(edit.id)
    implicit = []
    for tid in tracks:
        track = project.track_by_id(tid)
        if (
            track
            and track.media
            and not track.timeline_empty
            and not any(c.track_id == tid for c in project.clips)
        ):
            if timeline.origin_placement_lanes(
                tid, TimelineSec(-math.inf), TimelineSec(math.inf)
            ) - {tid}:
                return CutScopeHold(edit.id, (tid,), "source_geometry")
            duration = track.media.duration_sec
            if duration is None or not math.isfinite(duration) or duration <= 0:
                return CutScopeHold(edit.id, (), "media_extent_unavailable")
            implicit.append(full_span_clip(tid, duration))
    working = project.model_copy(deep=True) if implicit else project
    working.clips.extend(implicit)
    if scope == "track":
        proof.close()  # the proof ends where the first mutation starts
        report = punch_delete(
            working, edit.track_id, tl_start, tl_end, use_inaudible_opt=False, record_log=record_log
        )
        if working is not project:
            project.clips = working.clips
            project.transcripts = working.transcripts
            project.combined_transcript = working.combined_transcript
            project.timeline = working.timeline
        return (
            tl_start,
            tl_end,
            [edit.track_id],
            {
                "per_track_source": report["per_track_source"],
                "replace_gap_sec": None,
                "scope": scope,
                "use_inaudible_opt": consumed_inaudible_opt,
                "source_start": actual.start,
                "source_end": actual.end,
                **({"source_id": edit.source_id} if edit.source_timeline_span is not None else {}),
            },
        )
    assert removal is not None
    clearance = clear_ripple(
        working,
        removal,
        confirm_cut_speech=confirm_cut_speech,
        also_chosen=batch,
        timeline_caches=timeline_caches,
    )
    if isinstance(clearance, CutSpeechConfirmation):
        return clearance
    if (
        witnessed
        and not pause
        and (
            clearance.removal is None
            or len(clearance.removal.spans) != 1
            or abs(clearance.removal.spans[0][0] - float(seed[0])) > _SOURCE_GEOMETRY_TOLERANCE_SEC
            or abs(clearance.removal.spans[0][1] - float(seed[1])) > _SOURCE_GEOMETRY_TOLERANCE_SEC
        )
    ):
        return CutScopeHold(edit.id, (), "source_geometry")
    proof.close()  # the proof ends where the first mutation starts
    if working is not project:
        project.clips.extend(implicit)
    report = ripple_delete(
        project,
        clearance,
        record_log=record_log,
        params={"use_inaudible_opt": consumed_inaudible_opt},
    )
    tl_start, tl_end = report["timeline_start"], report["timeline_end"]
    per_track = report["per_track_source"]
    track_ids = list(per_track.keys()) or dialogue_track_ids(project) or [edit.track_id]
    samples = _apply_replace_gap_pad(
        project,
        actual,
        tl_start,
        exact_seam=pause,
        source_audio_caches=source_audio_caches,
    )
    effects = prepared_pause.plan.effects if prepared_pause is not None else ()
    matches = []
    for edge in effects:
        matched = []
        for clip in clips_for_track(project, edge.track_id):
            if clip.source_id != edge.source_id:
                continue
            try:
                media = recording_audio_path(project, clip.track_id, clip.source_id).resolve(
                    strict=True
                )
            except (CodedError, OSError, ValueError):
                continue
            if (
                same_recording(media, edge._media)
                and abs(
                    (clip.source_end if edge.side == "left" else clip.source_start)
                    - edge.source_sec
                )
                <= 1e-6
                and abs(
                    (clip.timeline_end if edge.side == "left" else clip.timeline_start)
                    - edge.timeline_sec
                )
                <= 1e-6
                and clip.source_start <= edge.source_start + 1e-6
                and clip.source_end >= edge.source_end - 1e-6
            ):
                matched.append(clip)
        if len(matched) != 1:
            raise CodedError(
                "The planned pause effects no longer match the consumed source.",
                code="pause_effect_geometry",
            )
        matches.append((edge, matched[0]))
    for edge, clip in matches:
        if edge.side == "left":
            clip.fade_out_ms = edge.milliseconds
        else:
            clip.fade_in_ms = edge.milliseconds
            clip.join_in_mode = ClipJoinMode.FADE
    return (
        tl_start,
        tl_end,
        track_ids,
        {
            "per_track_source": per_track,
            "replace_gap_sec": actual.replace_gap_sec,
            "scope": scope,
            "use_inaudible_opt": consumed_inaudible_opt,
            "source_start": actual.start,
            "source_end": actual.end,
            **({"source_id": edit.source_id} if edit.source_timeline_span is not None else {}),
            "crossfade_ms": actual.crossfade_ms,
            "next_burst_sec": actual.next_burst_sec,
            "pad_samples": samples,
            **(
                {
                    "loss_sec": tl_end - tl_start - (actual.replace_gap_sec or 0.0),
                    "edge_fades": [
                        {
                            "track_id": edge.track_id,
                            "source_id": edge.source_id,
                            "source_sec": edge.source_sec,
                            "timeline_sec": edge.timeline_sec,
                            "side": edge.side,
                            "milliseconds": edge.milliseconds,
                            "source_start": edge.source_start,
                            "source_end": edge.source_end,
                            "inherited_ms": edge.inherited_ms,
                        }
                        for edge in effects
                    ],
                }
                if pause
                else {}
            ),
            **clearance.log_params(),
        },
    )
