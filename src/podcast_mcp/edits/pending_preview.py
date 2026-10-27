"""Pending-edit preview windows and the approved result the Suggested side plays."""

from __future__ import annotations

import math
from dataclasses import dataclass

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_check_override import audio_check_override
from podcast_mcp.edits.timeline_span import map_source_span_fields, source_remove_timeline_spans
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.timeline_render import timeline_duration_sec
from podcast_mcp.models import AppliedEditRecord, EditDecision, EditDecisionType, EpisodeProject
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError

DEFAULT_PAD_SEC = 0.5
# A staged session's preview plays more around the change: the Review window is 3 s in all.
DEFAULT_SESSION_PAD_SEC = 1.5
DEFAULT_AB_GAP_SEC = 0.4
# The audition window is the edit plus ``pad_sec`` on each side. The Review card's A and B
# each play 3 s before the change through 3 s after it.
REVIEW_PAD_SEC = 3.0
MIN_PAD_SEC = 0.0
MAX_PAD_SEC = 10.0

# Holds from the cut-position and join checks: approving anyway is a person's call, so the
# preview plays what it would give. Pause-policy and project-integrity holds stay unavailable.
_PREVIEWABLE_HOLDS = frozenset({"acoustic_edge", "peer_speech", "speaker_bleed"})

SUGGEST_REASON_SPLIT = "A split does not change the mix until you delete a side."
SUGGEST_REASON_UNMAPPED = "This cut is not on the current timeline."
SUGGEST_REASON_NOTHING_LEFT = "Nothing is left to play around this edit once it is applied."
MIN_SUGGESTED_SEC = 0.05
SUGGEST_REASON_STALE_RANGE = "Selected audio changed. Select the range again."


def validate_pad_sec(pad_sec: float) -> float:
    """Return ``pad_sec`` when it is a finite number of seconds the window can pad by."""
    if isinstance(pad_sec, bool) or not isinstance(pad_sec, int | float):
        raise CodedValueError(
            f"pad_sec must be a number of seconds from {MIN_PAD_SEC:g} to {MAX_PAD_SEC:g}",
            code="pending_preview_pad_out_of_range",
        )
    if not math.isfinite(pad_sec) or not MIN_PAD_SEC <= pad_sec <= MAX_PAD_SEC:
        raise CodedValueError(
            f"pad_sec must be from {MIN_PAD_SEC:g} to {MAX_PAD_SEC:g} seconds",
            code="pending_preview_pad_out_of_range",
        )
    return float(pad_sec)


@dataclass(frozen=True)
class PendingPreviewSpan:
    """Where one rendered audition file sits, so a player can place its playheads.

    ``start_sec`` / ``end_sec`` are the file's first and last second on the timeline it
    was rendered from: the current timeline for ``current``, the timeline after the edit
    for ``suggested`` (the cut span is gone, so the join sits at ``edit_start_sec``).
    ``edit_start_sec`` / ``edit_end_sec`` are the edit's span on the current timeline,
    so on ``current`` the edit sits ``edit_start_sec - start_sec`` into the file.
    ``ab`` is one file of both sides, so its ``end_sec`` is the current side's.
    """

    edit_id: str
    mode: str
    pad_sec: float
    start_sec: float
    end_sec: float
    edit_start_sec: float
    edit_end_sec: float


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
    pad_sec: float = DEFAULT_PAD_SEC


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
    pad_sec = validate_pad_sec(pad_sec)
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
    pad_sec = validate_pad_sec(pad_sec)
    tl_start, tl_end, mappable = _timeline_span(project, edit)
    type_val = edit.type.value if hasattr(edit.type, "value") else str(edit.type)
    if edit.exact_range is not None:
        suggest_reason = None if mappable else SUGGEST_REASON_STALE_RANGE
    else:
        suggest_reason = _suggest_reason(type_val, mappable)
    play_start = max(0.0, tl_start - pad_sec)
    play_end = tl_end + pad_sec
    # Past the last audio there is nothing to play; the window ends with the timeline.
    timeline_end = timeline_duration_sec(project)
    if timeline_end > 0:
        play_end = min(play_end, max(timeline_end, tl_end))
    play_end = max(play_start + 0.05, play_end)
    return PendingPreviewWindow(
        edit_id=edit.id,
        timeline_start=tl_start,
        timeline_end=tl_end,
        play_start=play_start,
        play_end=play_end,
        suggest_reason=suggest_reason,
        pad_sec=pad_sec,
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
    play_end = window.play_end - _timeline_shift(applied[0])
    if play_end <= window.play_start + MIN_SUGGESTED_SEC:
        raise CodedValueError(SUGGEST_REASON_NOTHING_LEFT, code="pending_preview_unavailable")
    return play_end


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
