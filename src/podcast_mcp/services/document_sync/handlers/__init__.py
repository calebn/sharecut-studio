"""Document-command handler registry - unpack payload, call existing services."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.services.document_sync.handlers import (
    comments,
    edits,
    episode,
    history,
    markers,
    transcript,
)
from podcast_mcp.services.workspace import ProjectWorkspace

Handler = Callable[[ProjectWorkspace, dict[str, Any]], dict[str, Any]]

HANDLERS: dict[str, Handler] = {
    **comments.HANDLERS,
    "UndoHistory": history.undo_history,
    "RedoHistory": history.redo_history,
    "ApproveEdits": edits.approve_edits,
    "RejectEdits": edits.reject_edits,
    "UpdatePendingEdit": edits.update_pending_edit,
    "RestoreAppliedEdit": edits.restore_applied_edit,
    "SetClipFade": edits.set_clip_fade,
    "TrimClipEdge": edits.trim_clip_edge,
    "RollClipJoin": edits.roll_clip_join,
    "SetJoinMode": edits.set_join_mode,
    "ApplyFadeRecommendations": edits.apply_fade_recommendations,
    "SetEffectBypass": edits.set_effect_bypass,
    **transcript.HANDLERS,
    "AddChapter": markers.add_chapter,
    "UpdateChapter": markers.update_chapter,
    "DeleteChapter": markers.delete_chapter,
    "AddSocialClip": markers.add_social_clip,
    "UpdateSocialClip": markers.update_social_clip,
    "DeleteSocialClip": markers.delete_social_clip,
    "SetEnvelope": markers.set_envelope,
    "SuggestPendingEdit": markers.suggest_pending_edit,
    "SplitAtTime": edits.split_at_time,
    "DeleteClip": edits.delete_clip,
    "RippleDeleteClip": edits.ripple_delete_clip,
    "DuplicateSegment": edits.duplicate_segment,
    "MoveSegment": edits.move_segment,
    "MoveClips": edits.move_clips,
    "PasteSegment": edits.paste_segment,
    "RippleDeleteRange": edits.ripple_delete_range,
    "AddTrack": episode.add_track,
    "SetTrackMedia": episode.set_track_media,
    "SetTrackMeta": episode.set_track_meta,
    "RemoveTrack": episode.remove_track,
    "ReorderTrack": episode.reorder_track,
}


def apply_command(
    ws: ProjectWorkspace, command_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    handler = HANDLERS.get(command_type)
    if handler is None:
        raise ValueError(f"unknown document command: {command_type}")
    return handler(ws, payload)
