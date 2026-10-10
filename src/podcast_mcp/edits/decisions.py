from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise
from typing import Annotated, Literal

from pydantic import Field

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.clips_ops import abutting_pairs, clips_abut, clips_for_track
from podcast_mcp.edits.cut_quality import recommend_cut_fade_ms, recommend_post_pad_fade_in_ms
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    SourceExtent,
    UnconfirmedCutSpeech,
    confirmation_for,
    merge_cut_speech,
)
from podcast_mcp.edits.edit_impact import ImpactKind, record_impact
from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.filler_pacing import filler_pad_mode
from podcast_mcp.edits.inaudible_cuts import (
    OptimizedCutRange,
    optimize_source_cut_range,
)
from podcast_mcp.edits.join_modes import cap_fade_ms
from podcast_mcp.edits.mute_regions import add_source_mute
from podcast_mcp.edits.source_removals import (
    CutScopeHold,
    ScopeChangedAtApproval,
    consume_source_remove,
    require_source_remove,
)
from podcast_mcp.edits.timeline_ops import (
    mute_room_tone_fill,
    split_clips_at,
)
from podcast_mcp.edits.timeline_span import source_span_timeline_bounds
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    MUTE_FADE_MS,
    ClipJoinMode,
    ClipMuteRegion,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
)
from podcast_mcp.util.coded_error import CodedError, CodedKeyError
from podcast_mcp.util.review import reject_by_id


def _speaker_name(project: EpisodeProject, track_id: str) -> str:
    track = project.track_by_id(track_id)
    return track_id if track is None else track.speaker or track.label or track_id


def _tighten_cfg() -> dict:
    return dict(load_defaults().get("tighten", {}) or {})


def _mapped_edit_to_timeline_range(
    project: EpisodeProject, edit: EditDecision
) -> tuple[float, float] | None:
    start, end = source_span_timeline_bounds(
        SessionTimeline(project), edit.track_id, edit.start, edit.end
    )
    return (start, end) if start is not None and end is not None else None


def _edit_to_timeline_range(project: EpisodeProject, edit: EditDecision) -> tuple[float, float]:
    return _mapped_edit_to_timeline_range(project, edit) or (edit.start, edit.end)


def apply_join_fades_from_decisions(
    project: EpisodeProject,
    decisions: list[EditDecision],
    *,
    defaults: dict | None = None,
) -> dict:
    """Set per-join fade lengths on clip boundaries from applied edit decisions."""
    cfg = defaults or load_defaults()
    by_track: dict[str, list[EditDecision]] = {}
    for d in decisions:
        by_track.setdefault(d.track_id, []).append(d)

    affected: set[str] = set()
    for tid, decs in by_track.items():
        for left, right in abutting_pairs(clips_for_track(project, tid)):
            join_src = left.source_end
            matching = [
                d for d in decs if abs(d.end - join_src) < 0.08 or abs(d.start - join_src) < 0.08
            ]
            if not matching:
                continue
            fade = max(d.crossfade_ms for d in matching)
            if fade <= 0:
                fade = recommend_cut_fade_ms(
                    project,
                    tid,
                    left.source_end,
                    right.source_start,
                    cut_kind="filler",
                    defaults=cfg,
                )
            fade = cap_fade_ms(project, tid, fade, cfg)
            left.fade_out_ms = max(left.fade_out_ms, fade)
            right.fade_in_ms = max(right.fade_in_ms, fade)
            right.join_in_mode = ClipJoinMode.FADE
            affected.add(tid)

    return {
        "operation": "apply_join_fades",
        "affected_tracks": sorted(affected),
        "clip_count": len(project.clips),
        "timeline_duration_sec": project.timeline.duration_sec,
    }


def list_edit_decisions(
    project: EpisodeProject,
    *,
    applied: bool | None = None,
    review_required: bool | None = None,
    reason_prefix: str | None = None,
) -> list[EditDecision]:
    out: list[EditDecision] = []
    for e in project.edit_decisions:
        if applied is not None and e.applied != applied:
            continue
        if review_required is not None and e.review_required != review_required:
            continue
        if reason_prefix and not (e.reason or "").startswith(reason_prefix):
            continue
        out.append(e)
    return out


def _source_extents(removes: list[EditDecision]) -> tuple[SourceExtent, ...]:
    return tuple(SourceExtent(e.track_id, e.start, e.end) for e in removes)


def _pre_pad_fade_out_ms() -> int:
    return int(_tighten_cfg().get("filler_pre_pad_fade_out_ms", 5))


def _apply_mute_edit(
    project: EpisodeProject,
    edit: EditDecision,
) -> tuple[float, float, list[str], dict]:
    """Mute ``edit``'s source span in place, with the fill and fades a ripple pad gets.

    The region spans the edit plus its fades, so the edit itself is silent: the clip
    fades out into it as a padded cut fades into its pad, and back in after it over
    the post-pad fade-in, which ends before ``edit.next_burst_sec``. Clips do not move.
    """
    tl_start, tl_end = _edit_to_timeline_range(project, edit)
    room_tone = filler_pad_mode() == "room_tone"
    fade_out = _pre_pad_fade_out_ms()
    fade_in = (
        recommend_post_pad_fade_in_ms(
            project,
            edit.track_id,
            edit.end,
            next_burst_sec=edit.next_burst_sec,
            defaults=load_defaults(),
        )
        or MUTE_FADE_MS
    )
    span = (max(0.0, edit.start - fade_out / 1000.0), edit.end + fade_in / 1000.0)
    written = False
    for clip in clips_for_track(project, edit.track_id):
        if edit.end <= clip.source_start or edit.start >= clip.source_end:
            continue
        region = ClipMuteRegion(
            start_s=span[0],
            end_s=span[1],
            fill=mute_room_tone_fill(project, clip, edit.start, edit.end) if room_tone else None,
            fade_out_ms=fade_out,
            fade_in_ms=fade_in,
        )
        if add_source_mute(clip, region):
            written = True
    track_ids = [edit.track_id] if written else []
    return (
        tl_start,
        tl_end,
        track_ids,
        {
            "scope": getattr(edit, "scope", "session") or "session",
            "mute": True,
            # What reverting subtracts: the muted region, fades included.
            "per_track_source": {edit.track_id: list(span)} if written else {},
        },
    )


def approve_edits(
    project: EpisodeProject,
    ids: list[str],
    *,
    confirm_cut_speech: bool = False,
    allow_review: bool = True,
) -> int:
    """Apply the pending edits ``ids``.

    Each session remove clears the speech guard now, against the current transcript.
    Unless ``confirm_cut_speech``, a batch whose ripples would cut speech outside their
    suggested spans raises :class:`UnconfirmedCutSpeech` with every such remove's
    speech; the caller's mutation rolls back, so nothing applies. A session remove a peer
    is now speaking over raises :class:`ScopeChangedAtApproval` the same way.
    """
    from podcast_mcp.edits.range_edits import apply_ranges

    id_set = set(ids)
    applied_ids: set[str] = set()
    to_apply = [e for e in project.edit_decisions if e.id in id_set]
    exact = [e for e in to_apply if e.exact_range is not None]
    if exact:
        apply_ranges(project, exact)
        applied_ids.update(edit.id for edit in exact)
    to_apply = [e for e in to_apply if e.exact_range is None]
    # Mutes first (timeline-stable). Later removes first so earlier positions
    # stay valid after ripple+pad. Splits run after removes.
    mutes = [e for e in to_apply if e.type == EditDecisionType.MUTE]
    removes = [e for e in to_apply if e.type == EditDecisionType.REMOVE]
    splits = [e for e in to_apply if e.type == EditDecisionType.SPLIT]
    for edit in sorted(mutes, key=lambda e: e.start, reverse=True):
        tl_start, tl_end, track_ids, params = _apply_mute_edit(project, edit)
        if not track_ids:
            continue
        archive_decision(
            project,
            edit,
            operation="approve_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params=params,
        )
        applied_ids.add(edit.id)
    batch = _source_extents(removes)
    asked: list[CutSpeechConfirmation] = []
    held: list[CutScopeHold] = []
    for edit in sorted(removes, key=lambda e: e.start, reverse=True):
        applied = consume_source_remove(
            project,
            edit,
            confirm_cut_speech=confirm_cut_speech,
            allow_review=allow_review,
            batch=batch,
            use_inaudible_opt=False,
            record_log=False,
        )
        if isinstance(applied, CutSpeechConfirmation):
            asked.append(applied)
            continue
        if isinstance(applied, CutScopeHold):
            held.append(applied)
            continue
        tl_start, tl_end, track_ids, params = applied
        if not track_ids:
            continue
        archive_decision(
            project,
            edit,
            operation="approve_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params=params,
        )
        applied_ids.add(edit.id)
    if asked:
        raise UnconfirmedCutSpeech(confirmation_for(merge_cut_speech([a.speech for a in asked])))
    if held:
        raise ScopeChangedAtApproval(
            held,
            {tid: _speaker_name(project, tid) for h in held for tid in h.peers},
        )
    for edit in sorted(splits, key=lambda e: e.start, reverse=True):
        at_time = float(edit.start)
        tids = list(edit.track_ids) if edit.track_ids else [edit.track_id]
        report = split_clips_at(project, at_time, tids, record_log=False)
        archive_decision(
            project,
            edit,
            operation="approve_split",
            timeline_start=at_time,
            timeline_end=at_time,
            track_ids=list(report.get("affected_tracks") or tids),
            params={
                "at_time": at_time,
                "track_ids": tids,
                "split_source_by_track": report.get("split_source_by_track") or {},
            },
        )
        applied_ids.add(edit.id)

    before = len(project.edit_decisions)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in applied_ids]
    return before - len(project.edit_decisions)


def reject_edits(project: EpisodeProject, ids: list[str]) -> int:
    kept, removed = reject_by_id(
        project.edit_decisions,
        ids,
        get_id=lambda e: e.id,
    )
    project.edit_decisions = kept
    return removed


@dataclass(frozen=True)
class PendingEditBaseline:
    """The saved identity and bounds a pending-edit update was based on."""

    track_id: Annotated[str, Field(min_length=1)]
    type: EditDecisionType
    timebase: Literal["source", "timeline"]
    start: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    end: Annotated[float, Field(ge=0, allow_inf_nan=False)]


class PendingEditChangedError(CodedError, ValueError):
    """The saved pending decision no longer matches the editor's baseline."""

    code = "pending_edit_changed"


def require_pending_edit_baseline(
    project: EpisodeProject, edit_id: str, expected: PendingEditBaseline
) -> None:
    edit = next((item for item in project.edit_decisions if item.id == edit_id), None)
    if (
        edit is None
        or edit.applied
        or (edit.track_id, edit.type, edit.timebase, edit.start, edit.end)
        != (expected.track_id, expected.type, expected.timebase, expected.start, expected.end)
    ):
        raise PendingEditChangedError(
            "This pending edit changed since you reviewed it. Reload its current bounds "
            "before applying timing."
        )


@dataclass(frozen=True)
class PendingCutSuggestion:
    edit_id: str
    track_id: str
    original_start: float
    original_end: float
    optimized: OptimizedCutRange


def preview_pending_cut_range(project: EpisodeProject, edit_id: str) -> PendingCutSuggestion:
    """Suggest source bounds for one complete pending cut without changing it."""
    edit = next((e for e in project.edit_decisions if e.id == edit_id), None)
    if edit is None:
        raise CodedKeyError(f"edit decision not found: {edit_id}", code="edit_not_found")
    if edit.applied:
        raise ValueError("cut suggestions require a pending edit")
    if edit.type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE):
        raise ValueError("cut suggestions require a remove or mute edit")
    if edit.timebase != "source":
        raise ValueError("cut suggestions require source-time bounds")
    return PendingCutSuggestion(
        edit_id=edit.id,
        track_id=edit.track_id,
        original_start=edit.start,
        original_end=edit.end,
        optimized=optimize_source_cut_range(project, edit.track_id, edit.start, edit.end),
    )


def update_pending_edit(
    project: EpisodeProject,
    edit_id: str,
    *,
    start: float,
    end: float,
    snap: bool = True,
    track_ids: list[str] | None = None,
) -> EditDecision:
    """Update a pending edit decision's range; optionally inaudible-snap."""
    edit = next((e for e in project.edit_decisions if e.id == edit_id), None)
    if edit is None:
        raise CodedKeyError(f"edit decision not found: {edit_id}", code="edit_not_found")

    if edit.exact_range is not None:
        raise ValueError("Exact ranges cannot change source timing. Select the range again.")

    if edit.type == EditDecisionType.SPLIT:
        at_time = float(start)
        edit.start = at_time
        edit.end = at_time
        edit.timebase = "timeline"
        if track_ids is not None:
            edit.track_ids = list(track_ids)
            if track_ids:
                edit.track_id = track_ids[0]
        return edit

    if end <= start:
        raise ValueError("end must be after start")

    original = edit
    edit = edit.model_copy(deep=True)
    require_source_remove(project, edit.model_copy(update={"start": start, "end": end}))
    if snap:
        opt = optimize_source_cut_range(project, edit.track_id, start, end)
        edit.start = opt.start
        edit.end = opt.end
        edit.boundary_mode = opt.mode
        edit.cut_confidence = opt.confidence
    else:
        if start != edit.start or end != edit.end:
            edit.boundary_mode = None
            edit.cut_confidence = None
        edit.start = start
        edit.end = end
    require_source_remove(project, edit)
    project.edit_decisions = [edit if row is original else row for row in project.edit_decisions]
    return edit


def _apply_auto_removes(
    project: EpisodeProject,
    removes: list[EditDecision],
    *,
    inaudible_opt: bool,
    config_key: str,
) -> set[str]:
    """Ripple ``removes`` right to left, each counting the others as chosen.

    Returns the ids of the removes held back because they would cut other speech.
    """
    batch = _source_extents(removes)
    held: set[str] = set()
    for edit in sorted(removes, key=lambda e: e.start, reverse=True):
        applied = consume_source_remove(
            project,
            edit,
            confirm_cut_speech=False,
            allow_review=False,
            batch=batch,
            use_inaudible_opt=inaudible_opt and edit.boundary_mode is None,
            record_log=False,
        )
        if isinstance(applied, CutSpeechConfirmation | CutScopeHold):
            held.add(edit.id)
            continue
        tl_start, tl_end, track_ids, params = applied
        if not track_ids:
            continue
        edit.start = params["source_start"]
        edit.end = params["source_end"]
        edit.crossfade_ms = params.get("crossfade_ms", edit.crossfade_ms)
        edit.replace_gap_sec = params["replace_gap_sec"]
        archive_decision(
            project,
            edit,
            operation="apply_prefix_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params={**params, "config_key": config_key},
        )
    return held


def apply_prefix_edits(
    project: EpisodeProject,
    reason_prefix: str | tuple[str, ...],
    *,
    config_key: str,
) -> int:
    """Apply auto-approved REMOVE (ripple) or MUTE (in-place) edits for reason prefixes.

    A remove whose ripple would cut other speech stays pending for review, and the
    speech it covers is chosen by none of the removes that apply.
    """
    prefixes = (reason_prefix,) if isinstance(reason_prefix, str) else reason_prefix
    applied_decisions: list[EditDecision] = []
    for e in project.edit_decisions:
        if e.review_required or e.type not in (
            EditDecisionType.REMOVE,
            EditDecisionType.MUTE,
        ):
            continue
        reason = e.reason or ""
        if not reason.startswith(prefixes):
            continue
        tl_start, tl_end = _edit_to_timeline_range(project, e)
        if tl_end <= tl_start:
            continue
        applied_decisions.append(e)

    if not applied_decisions:
        return 0

    cfg_all = load_defaults()
    cfg = cfg_all.get(config_key, {})
    inaudible_opt = cfg.get("inaudible_opt", True)

    mutes = [e for e in applied_decisions if e.type == EditDecisionType.MUTE]
    removes = [e for e in applied_decisions if e.type == EditDecisionType.REMOVE]
    for edit in sorted(mutes, key=lambda e: e.start, reverse=True):
        tl_start, tl_end, track_ids, params = _apply_mute_edit(project, edit)
        if not track_ids:
            continue
        params = {**params, "config_key": config_key}
        archive_decision(
            project,
            edit,
            operation="apply_prefix_edits",
            timeline_start=tl_start,
            timeline_end=tl_end,
            track_ids=track_ids,
            params=params,
        )
    remove_ids = {e.id for e in removes}
    held: set[str] = set()
    while True:
        working = project.model_copy(deep=True)
        newly = _apply_auto_removes(
            working,
            [e for e in working.edit_decisions if e.id in remove_ids - held],
            inaudible_opt=inaudible_opt,
            config_key=config_key,
        )
        if newly:
            held |= newly
            continue
        from podcast_mcp.project_merge import adopt_project_state

        adopt_project_state(project, working)
        break
    applied_decisions = [e for e in applied_decisions if e.id not in held]

    apply_join_fades_from_decisions(
        project,
        [
            e
            for e in project.edit_decisions
            if e.id in remove_ids - held and not (e.reason or "").startswith("pause:")
        ],
        defaults=cfg_all,
    )
    id_set = {e.id for e in applied_decisions}
    before = len(project.edit_decisions)
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in id_set]
    return before - len(project.edit_decisions)


def apply_auto_edits(project: EpisodeProject) -> int:
    """Apply filler/pause edits (ripple REMOVE or mute-in-place MUTE)."""
    return apply_prefix_edits(project, ("filler:", "pause:"), config_key="tighten")


def _impact_segment(
    segment_id: str,
    track_id: str,
    start: float,
    end: float,
    duration_sec: float,
    reason: str | None,
    *,
    applied: bool,
    review_required: bool,
) -> dict:
    return {
        "id": segment_id,
        "track_id": track_id,
        "start": start,
        "end": end,
        "duration_sec": duration_sec,
        "reason": reason,
        "applied": applied,
        "review_required": review_required,
    }


def edit_impact_report(project: EpisodeProject) -> dict:
    """Seconds cut and edits applied, from decisions still in ``edit_decisions`` plus the edit log.

    Approval archives decisions into ``editorial.edit_log`` and drops them from
    ``edit_decisions``, so both sources count without overlap. Mutes count as
    applied edits but remove no time.
    """
    by_track: dict[str, float] = {}
    pending = 0
    applied = 0
    segments: list[dict] = []
    clip_count = len(project.clips)
    timeline_end = 0.0
    gap_count = 0
    for clip in project.clips:
        timeline_end = max(timeline_end, clip.timeline_end)
    for tid in {t.id for t in project.tracks}:
        track_clips = clips_for_track(project, tid)
        gap_count += sum(not clips_abut(left, right) for left, right in pairwise(track_clips))
    total_removed = 0.0
    for e in project.edit_decisions:
        if e.type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE):
            continue
        if e.applied:
            applied += 1
            if e.type == EditDecisionType.REMOVE:
                dur = max(0.0, e.end - e.start)
                by_track[e.track_id] = by_track.get(e.track_id, 0.0) + dur
                total_removed += dur
        elif e.review_required:
            pending += 1
        else:
            continue
        segments.append(
            _impact_segment(
                e.id,
                e.track_id,
                e.start,
                e.end,
                max(0.0, e.end - e.start),
                e.reason,
                applied=e.applied,
                review_required=e.review_required,
            )
        )
    for record in project.editorial.edit_log:
        impact = record_impact(record)
        if impact is None:
            continue
        applied += 1
        if impact.kind is ImpactKind.CUT:
            total_removed += impact.span_sec
            for tid in impact.spans_by_track:
                by_track[tid] = by_track.get(tid, 0.0) + impact.track_sec(tid)
        spans = [s for spans in impact.spans_by_track.values() for s in spans]
        if spans:
            segments.append(
                _impact_segment(
                    record.id,
                    ", ".join(impact.spans_by_track),
                    min(start for start, _ in spans),
                    max(end for _, end in spans),
                    impact.span_sec,
                    record.reason,
                    applied=True,
                    review_required=False,
                )
            )
    return {
        "total_removed_sec": total_removed,
        "by_track_sec": by_track,
        "applied_count": applied,
        "pending_review_count": pending,
        "segments": segments,
        "clip_count": clip_count,
        "timeline_duration_sec": timeline_end,
        "gap_count": gap_count,
    }


def format_edit_impact_markdown(report: dict) -> str:
    lines = [
        "# Edit impact",
        f"- Total removed (applied): **{report['total_removed_sec']:.1f}s**",
        f"- Applied edits: {report['applied_count']}",
        f"- Pending review: {report['pending_review_count']}",
        "",
    ]
    for tid, sec in report.get("by_track_sec", {}).items():
        lines.append(f"- {tid}: {sec:.1f}s")
    if report.get("segments"):
        lines.append("\n## Segments\n")
        for s in report["segments"][:50]:
            flag = "pending" if s.get("review_required") else "applied"
            lines.append(
                f"- [{flag}] {s['track_id']} {s['start']:.1f}-{s['end']:.1f}s "
                f"({s['duration_sec']:.1f}s) {s.get('reason', '')}"
            )
    return "\n".join(lines)
