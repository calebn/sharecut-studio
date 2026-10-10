from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    SourceExtent,
    clear_ripple,
)
from podcast_mcp.edits.filler_pacing import filler_pad_mode, pause_trim_is_imperceptible
from podcast_mcp.edits.inaudible_cuts import (
    optimize_timeline_cut_range,
)
from podcast_mcp.edits.ripple import ripple_track_ids
from podcast_mcp.edits.timeline_ops import (
    insert_gap,
    insert_room_tone_pad,
    plan_ripple_delete,
    punch_delete,
    ripple_delete,
)
from podcast_mcp.engines.session_timeline import SessionTimeline, origin_track_id_for_clip
from podcast_mcp.models import (
    ClipJoinMode,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
)
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids, recording_audio_path

if TYPE_CHECKING:
    from podcast_mcp.edits.timeline_ops import LaneUnavailable

_PAD_EDGE_MATCH_SEC = 0.05


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
        "pad_unavailable",
        "pause_air",
        "pause_join",
    ] = "peer_speech"
    unavailable_lanes: tuple[LaneUnavailable, ...] = ()
    detail: str | None = None


class ScopeChangedAtApproval(CodedError, ValueError):
    code = "cut_scope_changed"

    def __init__(self, held: Sequence[CutScopeHold], speakers: dict[str, str]):
        self.ids = tuple(h.edit_id for h in held)
        self.held = tuple(held)
        self.speakers = speakers
        reasons = {
            "source_geometry": "the selected audio no longer has one complete, continuous placement",
            "stored_track_pause": "a pause must shorten the session and cannot silence only one track",
            "speaker_bleed": "the selected audio is another speaker's bleed",
            "scope_unavailable": "the other tracks could not be checked",
            "media_extent_unavailable": "the full recording duration is unavailable",
            "operation_scope": "the selected audio plays outside the tracks this cut removes",
            "pause_not_shorter": "the replacement pad would leave the pause as long or longer",
            "pause_imperceptible": "the pause would shorten too little to hear",
            "pad_unavailable": "the pause needs room tone that is unavailable",
            "pause_air": "the pause cannot retain enough original quiet audio safely",
            "pause_join": "the final pause join did not pass its audio checks",
        }
        details = []
        for hold in held:
            peers = ", ".join(speakers.get(peer, peer) for peer in hold.peers)
            why = reasons.get(
                hold.reason,
                f"{peers or 'another track'} is speaking where the session cut would remove it",
            )
            if hold.unavailable_lanes:
                from podcast_mcp.edits.room_tone import SampleAbsent

                why += ": " + ", ".join(
                    f"{speakers.get(lane.track_id, lane.track_id)} ({lane.cause.cause if isinstance(lane.cause, SampleAbsent) else lane.cause})"
                    for lane in hold.unavailable_lanes
                )
            details.append(f"not applied ({hold.edit_id}): {why}")
        super().__init__(
            "; ".join(details)
            + ". Select the part to cut on the timeline, or reject the held cuts."
        )

    def for_delivery(self, delivery: Literal["saved", "suggested"]) -> ScopeChangedAtApproval:
        error = ScopeChangedAtApproval(self.held, self.speakers)
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
    span = timeline.exact_source_span(edit.track_id, SourceSec(edit.start), SourceSec(edit.end))
    if (
        span is None
        or timeline.exact_timeline_source_span(
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
    lanes = timeline.origin_placement_lanes(edit.track_id, *span)
    allowed = (
        {edit.track_id}
        if edit.scope == "track"
        else set(ripple_track_ids(project, [edit.track_id]))
    )
    if not lanes or not lanes <= allowed:
        return CutScopeHold(edit.id, (), "operation_scope")
    return span


def inspect_source_remove(
    project: EpisodeProject, edit: EditDecision, *, heard_pause_sec: float | None = None
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

            heard = SessionAir(project).silence_around(float(span[0]), float(span[1]))
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
        raise ScopeChangedAtApproval([assessment], {})


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
                right_pad_fade_in_ms = recommend_post_pad_fade_in_ms(
                    project,
                    tid,
                    clip.source_start,
                    next_burst_sec=edit.next_burst_sec,
                    defaults=defaults,
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
) -> tuple[float, float, list[str], dict] | CutSpeechConfirmation | CutScopeHold:
    """Prove and consume the actual ordinary source removal against current playback.

    A stored peer-speech review retains its confirmation path; fresh bleed or unavailable
    scope still holds. A hold changes no geometry. No downstream kernel re-optimizes the
    final proven window, and archived parameters name the consumed source and pad.
    """
    from podcast_mcp.edits.speech_energy_guard import CutScopeUnavailable, resolve_cut_scope
    from podcast_mcp.edits.track_media import full_span_clip

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
                "pad_unavailable",
                "pause_imperceptible",
                "pause_not_shorter",
                "source_geometry",
                "scope_unavailable",
                "pause_air",
            ] = (
                "pad_unavailable"
                if preparation.skip == "pad_unavailable"
                else "pause_imperceptible"
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
        opt = optimize_timeline_cut_range(
            project, edit.track_id, tl_start, tl_end, force_enabled=use_inaudible_opt
        )
        tl_start, tl_end = opt.start, opt.end
    else:
        removal = plan_ripple_delete(
            project,
            tl_start,
            tl_end,
            edited_track_ids=[edit.track_id],
            use_inaudible_opt=use_inaudible_opt,
        )
        if len(removal.spans) != 1:
            return CutScopeHold(edit.id, (), "source_geometry")
        tl_start, tl_end = removal.spans[0]
    source = SessionTimeline(project).exact_timeline_source_span(
        edit.track_id, TimelineSec(tl_start), TimelineSec(tl_end), on_origin_lane=scope == "track"
    )
    if source is None:
        return CutScopeHold(edit.id, (), "source_geometry")
    tracks = (
        [edit.track_id] if removal is None else ripple_track_ids(project, removal.edited_track_ids)
    )
    lanes = timeline.origin_placement_lanes(
        edit.track_id, TimelineSec(tl_start), TimelineSec(tl_end)
    )
    if not lanes or not lanes <= set(tracks):
        return CutScopeHold(edit.id, (), "operation_scope")
    actual = actual.model_copy(update={"start": float(source[0]), "end": float(source[1])})
    assessed = inspect_source_remove(
        project, actual, heard_pause_sec=prepared_pause.heard_pause if prepared_pause else None
    )
    if isinstance(assessed, CutScopeHold):
        return assessed
    if scope != "track":
        try:
            resolved = resolve_cut_scope(
                project,
                edit.track_id,
                actual.start,
                actual.end,
                requested_scope=scope,
                defaults=load_defaults(),
            )
        except ValueError as blocked:
            peers = tuple(getattr(blocked, "peers", ()))
            return CutScopeHold(edit.id, peers, "peer_speech" if peers else "scope_unavailable")
        if isinstance(resolved, CutScopeUnavailable):
            return CutScopeHold(edit.id, (), "scope_unavailable")
        if resolved.scope == "track":
            peers = resolved.guard.blocking_track_ids if resolved.guard else ()
            if resolved.cause == "speaker_bleed":
                return CutScopeHold(edit.id, peers, "speaker_bleed")
            if resolved.cause == "peer_speech" and edit.cut_speech is None:
                return CutScopeHold(edit.id, peers, "peer_speech")
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
                "source_start": actual.start,
                "source_end": actual.end,
            },
        )
    assert removal is not None
    clearance = clear_ripple(
        working, removal, confirm_cut_speech=confirm_cut_speech, also_chosen=batch
    )
    if isinstance(clearance, CutSpeechConfirmation):
        return clearance
    if working is not project:
        project.clips.extend(implicit)
    report = ripple_delete(
        project,
        clearance,
        record_log=record_log,
        params={"use_inaudible_opt": use_inaudible_opt},
    )
    tl_start, tl_end = report["timeline_start"], report["timeline_end"]
    per_track = report["per_track_source"]
    track_ids = list(per_track.keys()) or dialogue_track_ids(project) or [edit.track_id]
    samples = _apply_replace_gap_pad(project, actual, tl_start, exact_seam=pause)
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
            "source_start": actual.start,
            "source_end": actual.end,
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
