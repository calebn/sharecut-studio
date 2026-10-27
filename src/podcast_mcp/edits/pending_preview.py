"""Pending-edit preview windows and the approved result the Suggested side plays."""

from __future__ import annotations

from dataclasses import dataclass

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_check_override import audio_check_override
from podcast_mcp.edits.timeline_span import map_source_span_fields, source_remove_timeline_spans
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import AppliedEditRecord, EditDecision, EditDecisionType, EpisodeProject
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError

DEFAULT_PAD_SEC = 0.5
# A staged session's preview plays more around the change: the Review window is 3 s in all.
DEFAULT_SESSION_PAD_SEC = 1.5
DEFAULT_AB_GAP_SEC = 0.4

# Holds from the cut-position and join checks: approving anyway is a person's call, so the
# preview plays what it would give. Pause-policy and project-integrity holds stay unavailable.
_PREVIEWABLE_HOLDS = frozenset({"acoustic_edge", "peer_speech", "speaker_bleed"})

SUGGEST_REASON_SPLIT = "A split does not change the mix until you delete a side."
SUGGEST_REASON_UNMAPPED = "This cut is not on the current timeline."
SUGGEST_REASON_STALE_RANGE = "Selected audio changed. Select the range again."


@dataclass(frozen=True)
class PendingPreviewWindow:
    """Current-timeline window around one pending edit.

    ``suggest_reason`` says why the rendered Suggested side is unavailable (None when
    it renders).
    """

    edit_id: str
    timeline_start: float
    timeline_end: float
    play_start: float
    play_end: float
    suggest_reason: str | None


def _timeline_span(project: EpisodeProject, edit: EditDecision) -> tuple[float, float, bool]:
    if edit.exact_range is not None:
        from podcast_mcp.edits.range_target import range_is_current

        target = edit.exact_range
        return (
            target.intervals[0].start,
            target.intervals[-1].end,
            range_is_current(project, target),
        )
    type_val = edit.type.value if hasattr(edit.type, "value") else str(edit.type)
    if type_val == EditDecisionType.SPLIT.value or edit.timebase == "timeline":
        start = float(edit.start)
        end = float(edit.end)
        return start, end, True
    if (
        type_val == EditDecisionType.REMOVE.value
        and edit.timebase == "source"
        and (edit.source_id is not None or edit.source_timeline_span is not None)
    ):
        spans = source_remove_timeline_spans(project, edit)
        if spans is None:
            return 0.0, 0.0, False
        return spans[0]["start"], spans[-1]["end"], True
    timeline = SessionTimeline(project)
    mappable, _spans, mapped_start, mapped_end = map_source_span_fields(
        timeline, edit.track_id, edit.start, edit.end
    )
    if not mappable or mapped_start is None or mapped_end is None:
        return 0.0, 0.0, False
    return mapped_start, mapped_end, True


def resolve_pending_preview(
    project: EpisodeProject,
    edit_id: str,
    *,
    pad_sec: float = DEFAULT_PAD_SEC,
) -> PendingPreviewWindow:
    edit = next((e for e in project.edit_decisions if e.id == edit_id), None)
    if edit is None:
        raise CodedKeyError(f"pending edit not found: {edit_id}", code="edit_not_found")
    return preview_window_for_edit(project, edit, pad_sec=pad_sec)


def preview_window_for_edit(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    pad_sec: float = DEFAULT_PAD_SEC,
) -> PendingPreviewWindow:
    tl_start, tl_end, mappable = _timeline_span(project, edit)
    type_val = edit.type.value if hasattr(edit.type, "value") else str(edit.type)
    if edit.exact_range is not None:
        suggest_reason = None if mappable else SUGGEST_REASON_STALE_RANGE
    else:
        suggest_reason = _suggest_reason(type_val, mappable)
    play_start = max(0.0, tl_start - pad_sec)
    play_end = max(play_start + 0.05, tl_end + pad_sec)
    return PendingPreviewWindow(
        edit_id=edit.id,
        timeline_start=tl_start,
        timeline_end=tl_end,
        play_start=play_start,
        play_end=play_end,
        suggest_reason=suggest_reason,
    )


def _suggest_reason(type_val: str, mappable: bool) -> str | None:
    if type_val == EditDecisionType.SPLIT.value:
        return SUGGEST_REASON_SPLIT
    if not mappable:
        return SUGGEST_REASON_UNMAPPED
    return None


def apply_for_suggested(
    project: EpisodeProject, window: PendingPreviewWindow, *, defaults: EffectiveConfig
) -> float:
    """Approve ``window``'s edit on ``project`` (a snapshot) and return the Suggested end.

    The edit applies through ``approve_edits``, so the snapshot carries the same ripple,
    paced pad and fades that approving ships. The window's post-roll moves with the
    timeline after the edit.
    """
    from podcast_mcp.edits.cut_application import approve_edits
    from podcast_mcp.edits.source_removals import ScopeChangedAtApproval

    logged = len(project.editorial.edit_log)
    # Suggested plays what Approve gives. A cut the audio checks hold plays as it would
    # if approved anyway (the snapshot is discarded), so the person can hear it first.
    try:
        try:
            approve_edits(project, [window.edit_id], defaults=defaults)
        except ScopeChangedAtApproval as held:
            if not all(h.reason in _PREVIEWABLE_HOLDS for h in held.held):
                raise
            with audio_check_override("preview", "preview"):
                approve_edits(project, [window.edit_id], defaults=defaults)
    except ScopeChangedAtApproval as held:
        raise held.for_delivery("suggested") from held
    applied = project.editorial.edit_log[logged:]
    if not applied:
        raise CodedValueError(SUGGEST_REASON_UNMAPPED, code="pending_preview_unavailable")
    return window.play_end - _timeline_shift(applied[0])


def _timeline_shift(record: AppliedEditRecord) -> float:
    """Seconds the timeline after ``record``'s span moved earlier when it applied.

    Mutes, track punches and exact ranges leave a hole in place. A session ripple
    closes its span and opens the paced pad (``replace_gap_sec``) in its place.
    """
    params = record.params
    if params.get("mute") or params.get("scope") == "track" or "exact_range" in params:
        return 0.0
    if record.timeline_start is None or record.timeline_end is None:
        raise CodedValueError(
            "applied edit lacks timeline bounds. Refresh the pending edit and try again.",
            code="pending_preview_unavailable",
        )
    pad = float(params.get("replace_gap_sec") or 0.0)
    return (record.timeline_end - record.timeline_start) - pad
