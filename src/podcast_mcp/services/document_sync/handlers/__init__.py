"""Document-command handler registry - unpack payload, call existing services."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.handlers import (
    comments,
    edits,
    episode,
    history,
    markers,
    transcript,
)
from podcast_mcp.util.coded_error import CodedValueError

Handler = Callable[[ProjectWorkspace, dict[str, Any]], dict[str, Any]]

HANDLERS: dict[str, Handler] = {
    **comments.HANDLERS,
    "UndoHistory": history.undo_history,
    "RedoHistory": history.redo_history,
    "EditSelectedRange": edits.edit_selected_range,
    "ApproveEdits": edits.approve_edits,
    "RejectEdits": edits.reject_edits,
    "ApplySuggestedActions": edits.apply_suggested_actions,
    "UpdatePendingEdit": edits.update_pending_edit,
    "RestoreAppliedEdit": edits.restore_applied_edit,
    "RestoreClipBleed": edits.restore_clip_bleed,
    "SetClipFade": edits.set_clip_fade,
    "TrimClipEdge": edits.trim_clip_edge,
    "RollClipJoin": edits.roll_clip_join,
    "SetJoinMode": edits.set_join_mode,
    "SetClipJoin": edits.set_clip_join,
    "ApplyFadeRecommendations": edits.apply_fade_recommendations,
    "ApplyFadeRecommendationList": edits.apply_fade_recommendation_list,
    "SetEffectBypass": edits.set_effect_bypass,
    "AddEffect": edits.add_effect,
    "ReconcileTranscript": edits.reconcile_transcript,
    "SuppressBleed": edits.suppress_bleed,
    "SuppressLowAudibility": edits.suppress_low_audibility,
    "SetBleedAlignmentMode": edits.set_bleed_alignment_mode,
    "RemoveEffect": edits.remove_effect,
    **transcript.HANDLERS,
    "AddChapter": markers.add_chapter,
    "UpdateChapter": markers.update_chapter,
    "DeleteChapter": markers.delete_chapter,
    "AddSocialClip": markers.add_social_clip,
    "UpdateSocialClip": markers.update_social_clip,
    "DeleteSocialClip": markers.delete_social_clip,
    "SetEnvelope": markers.set_envelope,
    "SuggestPendingEdit": markers.suggest_pending_edit,
    "StageTimeRangeCut": edits.stage_time_range_cut,
    "StageTextMatchCut": edits.stage_text_match_cut,
    "StageUtteranceCut": edits.stage_utterance_cut,
    "StageWordsCut": edits.stage_words_cut,
    "SplitAtTime": edits.split_at_time,
    "DeleteClip": edits.delete_clip,
    "DuplicateSegment": edits.duplicate_segment,
    "MoveSegment": edits.move_segment,
    "InsertGap": edits.insert_gap,
    "FillRoomTone": edits.fill_room_tone,
    "ApplyAutoEdits": edits.apply_auto_edits,
    "ApplyEditPlan": edits.apply_edit_plan,
    "ShortenWordGaps": edits.shorten_word_gaps,
    "FadeJoins": edits.fade_joins,
    "CrossfadeJoins": edits.crossfade_joins,
    "MoveByText": edits.move_by_text,
    "MoveClips": edits.move_clips,
    "PasteSegment": edits.paste_segment,
    "CutRange": edits.cut_range,
    "RippleDeleteText": edits.ripple_delete_text,
    "AddTrack": episode.add_track,
    "SetTrackMedia": episode.set_track_media,
    "SetTrackMeta": episode.set_track_meta,
    "SetTrackFader": episode.set_track_volume,
    "SetTrackMute": episode.set_track_mute,
    "RemoveTrack": episode.remove_track,
    "ReorderTrack": episode.reorder_track,
}


def apply_command(
    ws: ProjectWorkspace, command_type: str, payload: dict[str, Any]
) -> dict[str, Any]:
    handler = HANDLERS.get(command_type)
    if handler is None:
        raise CodedValueError(
            f"unknown document command: {command_type}", code="document_command_unknown"
        )
    return handler(ws, payload)
