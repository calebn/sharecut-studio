"""Listen-first pending-edit preview windows (session-clock skip)."""

from __future__ import annotations

from dataclasses import dataclass

from podcast_mcp.edits.timeline_span import map_source_span_fields
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EditDecision, EditDecisionType, EpisodeProject

DEFAULT_PAD_SEC = 0.5
DEFAULT_AB_GAP_SEC = 0.4

SKIP_REASON_SPLIT = "A split does not change the mix until you delete a side."
SKIP_REASON_TRACK = "Track punch keeps timeline length. Hear Current around the hole."
SKIP_REASON_MUTE = "Mute-in-place keeps timeline length. Hear Current around the hole."
SKIP_REASON_UNMAPPED = "This cut is not on the current timeline."
SKIP_REASON_TOO_SHORT = "This cut is too short for a Suggested skip."
SKIP_REASON_SESSION_ONLY = "Suggested skip is only for session-wide removes."


@dataclass(frozen=True)
class PendingPreviewWindow:
    edit_id: str
    timeline_start: float
    timeline_end: float
    play_start: float
    play_end: float
    can_skip: bool
    skip_reason: str | None


def _timeline_span(project: EpisodeProject, edit: EditDecision) -> tuple[float, float, bool]:
    type_val = edit.type.value if hasattr(edit.type, "value") else str(edit.type)
    if type_val == EditDecisionType.SPLIT.value or edit.timebase == "timeline":
        start = float(edit.start)
        end = float(edit.end)
        return start, end, True
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
        raise KeyError(f"pending edit not found: {edit_id}")
    return preview_window_for_edit(project, edit, pad_sec=pad_sec)


def preview_window_for_edit(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    pad_sec: float = DEFAULT_PAD_SEC,
) -> PendingPreviewWindow:
    tl_start, tl_end, mappable = _timeline_span(project, edit)
    type_val = edit.type.value if hasattr(edit.type, "value") else str(edit.type)
    can_skip = (
        type_val == EditDecisionType.REMOVE.value
        and (edit.scope or "session") == "session"
        and mappable
        and tl_end - tl_start > 0.02
    )
    skip_reason: str | None = None
    if not can_skip:
        if type_val == EditDecisionType.SPLIT.value:
            skip_reason = SKIP_REASON_SPLIT
        elif type_val == EditDecisionType.MUTE.value:
            skip_reason = SKIP_REASON_MUTE
        elif (edit.scope or "session") == "track":
            skip_reason = SKIP_REASON_TRACK
        elif not mappable:
            skip_reason = SKIP_REASON_UNMAPPED
        elif tl_end - tl_start <= 0.02:
            skip_reason = SKIP_REASON_TOO_SHORT
        else:
            skip_reason = SKIP_REASON_SESSION_ONLY
    play_start = max(0.0, tl_start - pad_sec)
    play_end = max(play_start + 0.05, tl_end + pad_sec)
    return PendingPreviewWindow(
        edit_id=edit.id,
        timeline_start=tl_start,
        timeline_end=tl_end,
        play_start=play_start,
        play_end=play_end,
        can_skip=can_skip,
        skip_reason=skip_reason,
    )
