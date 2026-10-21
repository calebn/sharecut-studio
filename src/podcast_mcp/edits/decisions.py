from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise
from typing import Annotated, Any, Literal

from pydantic import Field

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_check_override import active_override
from podcast_mcp.edits.clips_ops import clips_abut, clips_for_track
from podcast_mcp.edits.cut_speech import (
    CutSpeechConfirmation,
    LaneSourceExtent,
    RecordingSourceExtent,
    SourceExtent,
)
from podcast_mcp.edits.edit_impact import ImpactKind, record_impact
from podcast_mcp.edits.inaudible_cuts import (
    CutWordIndex,
    OptimizedCutRange,
    optimize_source_cut_range,
)
from podcast_mcp.edits.source_removals import (
    require_source_remove,
    resize_source_remove,
)
from podcast_mcp.edits.timeline_span import source_span_timeline_bounds
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    CutIntent,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
)
from podcast_mcp.util.coded_error import CodedError, CodedKeyError, CodedValueError
from podcast_mcp.util.review import reject_by_id


def _speaker_name(project: EpisodeProject, track_id: str) -> str:
    track = project.track_by_id(track_id)
    return track_id if track is None else track.speaker or track.label or track_id


def edit_timeline_range(
    project: EpisodeProject, edit: EditDecision, timeline: SessionTimeline | None = None
) -> tuple[float, float] | None:
    """The timeline range a clip plays ``edit``'s source span at; ``None`` when none does."""
    start, end = source_span_timeline_bounds(
        timeline or SessionTimeline(project), edit.track_id, edit.start, edit.end
    )
    return (start, end) if start is not None and end is not None else None


def _plays_source_span(edit: EditDecision) -> bool:
    """Whether ``edit`` names source seconds that a clip has to play for it to apply."""
    return (
        not edit.applied
        and edit.timebase == "source"
        and edit.exact_range is None
        and edit.type in (EditDecisionType.REMOVE, EditDecisionType.MUTE)
    )


def unplayed_pending_ids(project: EpisodeProject, ids: set[str] | None = None) -> list[str]:
    """Ids of pending remove/mute proposals whose source span no clip plays any more.

    ``ids`` limits the check to those proposals; ``None`` checks every pending one.
    """
    candidates = [
        e for e in project.edit_decisions if _plays_source_span(e) and (ids is None or e.id in ids)
    ]
    if not candidates:
        return []
    timeline = SessionTimeline(project)
    return [e.id for e in candidates if edit_timeline_range(project, e, timeline) is None]


def retire_unplayed_pending(project: EpisodeProject) -> int:
    """Drop pending proposals whose audio was cut away, so none is offered for approval (#1487)."""
    stale = set(unplayed_pending_ids(project))
    if not stale:
        return 0
    project.edit_decisions = [e for e in project.edit_decisions if e.id not in stale]
    return len(stale)


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


def _near(a: SourceExtent, b: SourceExtent, gap: float = 0.5) -> bool:
    """Whether two source spans overlap or sit within ``gap`` seconds of each other."""
    return a.start - gap <= b.end and b.start - gap <= a.end


def _near_on_timeline(
    a: tuple[float, float] | None, b: tuple[float, float] | None, gap: float = 0.5
) -> bool:
    """Whether two timeline spans overlap or sit within ``gap`` seconds; unmapped counts as near."""
    if a is None or b is None:
        return True
    return a[0] - gap <= b[1] and b[0] - gap <= a[1]


def _source_extents(removes: list[EditDecision]) -> dict[str, SourceExtent]:
    return {
        e.id: (
            RecordingSourceExtent(e.track_id, e.start, e.end, e.source_id)
            if e.source_timeline_span is not None
            else LaneSourceExtent(e.track_id, e.start, e.end)
        )
        for e in removes
    }


def pre_pad_fade_out_ms(defaults: EffectiveConfig) -> int:
    return int(defaults.get("tighten", {}).get("filler_pre_pad_fade_out_ms", 5))


def reject_edits(project: EpisodeProject, ids: list[str]) -> int:
    kept, removed = reject_by_id(
        project.edit_decisions,
        ids,
        get_id=lambda e: e.id,
    )
    project.edit_decisions = kept
    return removed


@dataclass(frozen=True)
class AskedEdits:
    """Pending cuts Approve all left for a confirmation, and the ask to show."""

    edit_ids: tuple[str, ...]
    confirmation: CutSpeechConfirmation


@dataclass(frozen=True)
class HeldEdit:
    """A pending cut Approve all left in the list, with the reason the list shows."""

    edit_id: str
    label: str
    reason: str


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


def preview_pending_cut_range(
    project: EpisodeProject, edit_id: str, *, defaults: EffectiveConfig
) -> PendingCutSuggestion:
    """Suggest source bounds for one complete pending cut without changing it."""
    edit = next((e for e in project.edit_decisions if e.id == edit_id), None)
    if edit is None:
        raise CodedKeyError(f"edit decision not found: {edit_id}", code="edit_not_found")
    if edit.applied:
        raise CodedValueError(
            "cut suggestions require a pending edit",
            code="cut_suggestion_unavailable",
        )
    if edit.type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE):
        raise CodedValueError(
            "cut suggestions require a remove or mute edit. Pick a remove or mute edit.",
            code="cut_suggestion_unavailable",
        )
    if edit.timebase != "source":
        raise CodedValueError(
            "cut suggestions require source-time bounds. Pick an edit that has source-time bounds.",
            code="cut_suggestion_unavailable",
        )
    return PendingCutSuggestion(
        edit_id=edit.id,
        track_id=edit.track_id,
        original_start=edit.start,
        original_end=edit.end,
        optimized=optimize_source_cut_range(
            project, edit.track_id, edit.start, edit.end, defaults=defaults
        ),
    )


def update_pending_edit(
    project: EpisodeProject,
    edit_id: str,
    *,
    start: float,
    end: float,
    snap: bool = True,
    track_ids: list[str] | None = None,
    boundary_intent: CutIntent = CutIntent.PROGRAMMATIC,
    defaults: EffectiveConfig,
) -> EditDecision:
    """Update a pending edit decision's range; optionally inaudible-snap.

    Under the owner's audio-check override the bounds stay exactly as given: no snapping,
    and the edit records them as chosen boundaries so approval does not re-hold them.
    """
    if active_override() is not None:
        snap = False
        boundary_intent = CutIntent.HUMAN_BOUNDARIES
    edit = next((e for e in project.edit_decisions if e.id == edit_id), None)
    if edit is None:
        raise CodedKeyError(f"edit decision not found: {edit_id}", code="edit_not_found")

    if edit.exact_range is not None:
        raise CodedValueError(
            "Exact ranges cannot change source timing. Select the range again.",
            code="exact_range_locked",
        )

    if edit.type == EditDecisionType.SPLIT:
        at_time = float(start)
        edit.start = at_time
        edit.end = at_time
        edit.timebase = "timeline"
        edit.boundary_intent = boundary_intent
        if track_ids is not None:
            edit.track_ids = list(track_ids)
            if track_ids:
                edit.track_id = track_ids[0]
        return edit

    if end <= start:
        raise CodedValueError(
            "end must be after start. Pick an end later than the start.",
            code="range_end_before_start",
        )

    original = edit
    if (
        edit.type == EditDecisionType.REMOVE
        and edit.timebase == "source"
        and edit.source_timeline_span is not None
    ):
        edit = resize_source_remove(project, edit, start=start, end=end)
    else:
        edit = edit.model_copy(deep=True)
        edit.start = start
        edit.end = end
    require_source_remove(project, edit)
    if snap:
        optimizer_kwargs: dict[str, Any] = {"defaults": defaults}
        if edit.source_id is not None:
            selected_transcript = project.transcript_for_source(edit.track_id, edit.source_id)
            optimizer_kwargs["word_index"] = CutWordIndex.from_transcript(
                selected_transcript, edit.track_id
            )
        opt = optimize_source_cut_range(
            project,
            edit.track_id,
            start,
            end,
            source_id=edit.source_id,
            **optimizer_kwargs,
        )
        if edit.type == EditDecisionType.REMOVE and edit.source_timeline_span is not None:
            edit = resize_source_remove(project, original, start=opt.start, end=opt.end)
        else:
            edit.start = opt.start
            edit.end = opt.end
        edit.boundary_mode = opt.mode
        edit.cut_confidence = opt.confidence
    else:
        if start != original.start or end != original.end:
            edit.boundary_mode = None
            edit.cut_confidence = None
        edit.start = start
        edit.end = end
    edit.boundary_intent = boundary_intent
    from podcast_mcp.edits.cut_application import assess_source_offer

    assess_source_offer(project, edit, defaults=defaults)
    require_source_remove(project, edit)
    project.edit_decisions = [edit if row is original else row for row in project.edit_decisions]
    return edit


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
