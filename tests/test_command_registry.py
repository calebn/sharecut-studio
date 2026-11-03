"""Characterization of the document command tables: payload model, handler and guest role per type.

The snapshot below was taken from the hand-kept tables before they were derived from one
registry (#3115 slice 2). It must keep passing unchanged, so a refactor of how the tables are
built cannot change who may run what or which handler runs.
"""

from __future__ import annotations

from typing import get_args

import pytest

from podcast_mcp.services.collaboration import ReviewRole
from podcast_mcp.services.document_sync import capabilities as caps
from podcast_mcp.services.document_sync.commands import DocumentCommandType
from podcast_mcp.services.document_sync.handlers import HANDLERS
from podcast_mcp.services.document_sync.payloads import _PAYLOAD_BY_TYPE

# type: (payload model, handler as module.function, guest access)
# guest access: host (host-only), comment (comment path, in no role set), commenter (proposes
# only), commenter+apply (proposes as Commenter, applies as Editor), editor (Editor applies).
SNAPSHOT: dict[str, tuple[str, str, str]] = {
    "AddComment": ("AddCommentPayload", "comments.add_comment", "comment"),
    "UpdateComment": ("UpdateCommentPayload", "comments.update_comment", "comment"),
    "ResolveComment": ("ResolveCommentPayload", "comments.resolve_comment", "comment"),
    "DeleteComment": ("DeleteCommentPayload", "comments.delete_comment", "comment"),
    "AddReply": ("AddReplyPayload", "comments.add_reply", "comment"),
    "SetActionDone": ("SetActionDonePayload", "comments.set_action_done", "comment"),
    "AddAction": ("AddActionPayload", "comments.add_action", "comment"),
    "UndoHistory": ("UndoHistoryPayload", "history.undo_history", "editor"),
    "RedoHistory": ("RedoHistoryPayload", "history.redo_history", "editor"),
    "ApproveEdits": ("ApproveEditsPayload", "edits.approve_edits", "editor"),
    "RejectEdits": ("RejectEditsPayload", "edits.reject_edits", "editor"),
    "ApplySuggestedActions": (
        "ApplySuggestedActionsPayload",
        "edits.apply_suggested_actions",
        "editor",
    ),
    "UpdatePendingEdit": (
        "UpdatePendingEditPayload",
        "edits.update_pending_edit",
        "commenter+apply",
    ),
    "RestoreAppliedEdit": ("RestoreAppliedEditPayload", "edits.restore_applied_edit", "editor"),
    "RestoreClipBleed": ("RestoreClipBleedPayload", "edits.restore_clip_bleed", "editor"),
    "SetClipFade": ("SetClipFadePayload", "edits.set_clip_fade", "editor"),
    "TrimClipEdge": ("TrimClipEdgePayload", "edits.trim_clip_edge", "editor"),
    "RollClipJoin": ("RollClipJoinPayload", "edits.roll_clip_join", "editor"),
    "SetJoinMode": ("SetJoinModePayload", "edits.set_join_mode", "editor"),
    "SetClipJoin": ("SetClipJoinPayload", "edits.set_clip_join", "editor"),
    "ApplyFadeRecommendations": (
        "ApplyFadeRecommendationsPayload",
        "edits.apply_fade_recommendations",
        "editor",
    ),
    "ApplyFadeRecommendationList": (
        "ApplyFadeRecommendationListPayload",
        "edits.apply_fade_recommendation_list",
        "editor",
    ),
    "SetEffectBypass": ("SetEffectBypassPayload", "edits.set_effect_bypass", "editor"),
    "AddEffect": ("AddEffectPayload", "edits.add_effect", "editor"),
    "ReconcileTranscript": ("ReconcileTranscriptPayload", "edits.reconcile_transcript", "editor"),
    "SuppressBleed": ("SuppressBleedPayload", "edits.suppress_bleed", "editor"),
    "SuppressLowAudibility": (
        "SuppressLowAudibilityPayload",
        "edits.suppress_low_audibility",
        "editor",
    ),
    "SetBleedAlignmentMode": (
        "SetBleedAlignmentModePayload",
        "edits.set_bleed_alignment_mode",
        "editor",
    ),
    "RemoveEffect": ("RemoveEffectPayload", "edits.remove_effect", "editor"),
    "ReplaceTranscriptMatches": (
        "ReplaceTranscriptMatchesPayload",
        "transcript.replace_transcript_matches",
        "editor",
    ),
    "CorrectTranscriptWord": (
        "CorrectTranscriptWordPayload",
        "transcript.correct_transcript_word",
        "editor",
    ),
    "ApplyTranscriptCleanup": (
        "ApplyTranscriptCleanupPayload",
        "transcript.apply_transcript_cleanup",
        "editor",
    ),
    "VerifyTranscript": ("VerifyTranscriptPayload", "transcript.verify_transcript", "editor"),
    "CorrectTranscriptPhrase": (
        "CorrectTranscriptPhrasePayload",
        "transcript.correct_transcript_phrase",
        "editor",
    ),
    "SetTranscriptWordSuppressed": (
        "SetTranscriptWordSuppressedPayload",
        "transcript.set_transcript_word_suppressed",
        "editor",
    ),
    "SetTranscriptWordAutomatic": (
        "SetTranscriptWordAutomaticPayload",
        "transcript.set_transcript_word_automatic",
        "editor",
    ),
    "SetTranscriptWordsIgnored": (
        "SetTranscriptWordsIgnoredPayload",
        "transcript.set_transcript_words_ignored",
        "editor",
    ),
    "SetTranscriptWordTiming": (
        "SetTranscriptWordTimingPayload",
        "transcript.set_transcript_word_timing",
        "editor",
    ),
    "AddChapter": ("AddChapterPayload", "markers.add_chapter", "editor"),
    "UpdateChapter": ("UpdateChapterPayload", "markers.update_chapter", "editor"),
    "DeleteChapter": ("DeleteChapterPayload", "markers.delete_chapter", "editor"),
    "SetFeedField": ("SetFeedFieldPayload", "feed.set_feed_field", "editor"),
    "ClearFeedField": ("ClearFeedFieldPayload", "feed.clear_feed_field", "editor"),
    "AddSocialClip": ("AddSocialClipPayload", "markers.add_social_clip", "editor"),
    "UpdateSocialClip": ("UpdateSocialClipPayload", "markers.update_social_clip", "editor"),
    "UpdateSocialClipDetails": (
        "UpdateSocialClipDetailsPayload",
        "markers.update_social_clip_details",
        "host",
    ),
    "DeleteSocialClip": ("DeleteSocialClipPayload", "markers.delete_social_clip", "editor"),
    "SetEnvelope": ("SetEnvelopePayload", "markers.set_envelope", "editor"),
    "EditSelectedRange": (
        "EditSelectedRangePayload",
        "edits.edit_selected_range",
        "commenter+apply",
    ),
    "SuggestPendingEdit": (
        "SuggestPendingEditPayload",
        "markers.suggest_pending_edit",
        "commenter",
    ),
    "StageTimeRangeCut": ("StageTimeRangeCutPayload", "edits.stage_time_range_cut", "editor"),
    "StageTextMatchCut": ("StageTextMatchCutPayload", "edits.stage_text_match_cut", "editor"),
    "StageUtteranceCut": ("StageUtteranceCutPayload", "edits.stage_utterance_cut", "editor"),
    "StageWordsCut": ("StageWordsCutPayload", "edits.stage_words_cut", "editor"),
    "SplitAtTime": ("SplitAtTimePayload", "edits.split_at_time", "commenter+apply"),
    "DeleteClip": ("DeleteClipPayload", "edits.delete_clip", "commenter+apply"),
    "DuplicateSegment": ("DuplicateSegmentPayload", "edits.duplicate_segment", "editor"),
    "MoveSegment": ("MoveSegmentPayload", "edits.move_segment", "editor"),
    "InsertGap": ("InsertGapPayload", "edits.insert_gap", "editor"),
    "InsertSegment": ("InsertSegmentPayload", "edits.insert_segment", "host"),
    "FillRoomTone": ("FillRoomTonePayload", "edits.fill_room_tone", "editor"),
    "ApplyAutoEdits": ("ApplyAutoEditsPayload", "edits.apply_auto_edits", "editor"),
    "ProposeTighten": ("ProposeTightenPayload", "edits.propose_tighten", "editor"),
    "ApplyEditPlan": ("ApplyEditPlanPayload", "edits.apply_edit_plan", "editor"),
    "ShortenWordGaps": ("ShortenWordGapsPayload", "edits.shorten_word_gaps", "editor"),
    "StripSilence": ("StripSilencePayload", "edits.strip_silence", "editor"),
    "FadeJoins": ("FadeJoinsPayload", "edits.fade_joins", "editor"),
    "CrossfadeJoins": ("CrossfadeJoinsPayload", "edits.crossfade_joins", "editor"),
    "MoveByText": ("MoveByTextPayload", "edits.move_by_text", "editor"),
    "MoveClips": ("MoveClipsPayload", "edits.move_clips", "editor"),
    "PasteSegment": ("PasteSegmentPayload", "edits.paste_segment", "editor"),
    "CutRange": ("CutRangePayload", "edits.cut_range", "editor"),
    "RippleDeleteText": ("RippleDeleteTextPayload", "edits.ripple_delete_text", "editor"),
    "RenameProject": ("RenameProjectPayload", "episode.rename_project", "editor"),
    "SetRecordSessionName": (
        "SetRecordSessionNamePayload",
        "episode.set_record_session_name",
        "host",
    ),
    "AcceptSessionSuggestion": (
        "AcceptSessionSuggestionPayload",
        "session_suggestion.accept_session_suggestion",
        "host",
    ),
    "SkipSessionSuggestion": (
        "SkipSessionSuggestionPayload",
        "session_suggestion.skip_session_suggestion",
        "host",
    ),
    "SelectSessionTake": (
        "SelectSessionTakePayload",
        "session_suggestion.select_session_take",
        "host",
    ),
    "AddTrack": ("AddTrackPayload", "episode.add_track", "editor"),
    "SetTrackMedia": ("SetTrackMediaPayload", "episode.set_track_media", "editor"),
    "SetTrackMeta": ("SetTrackMetaPayload", "episode.set_track_meta", "editor"),
    "SetTrackFader": ("SetTrackFaderPayload", "episode.set_track_volume", "editor"),
    "SetTrackMute": ("SetTrackMutePayload", "episode.set_track_mute", "editor"),
    "RemoveTrack": ("RemoveTrackPayload", "episode.remove_track", "editor"),
    "ReorderTrack": ("ReorderTrackPayload", "episode.reorder_track", "editor"),
}


def _handler_name(handler) -> str:
    return f"{handler.__module__.rsplit('.', 1)[1]}.{handler.__name__}"


def _access(command_type: str) -> str:
    if command_type in caps.HOST_ONLY_DOCUMENT_COMMANDS:
        return "host"
    if command_type in caps.COMMENT_COMMANDS:
        return "comment"
    suggest = command_type in caps.SUGGEST_COMMANDS
    apply = command_type in caps.EDIT_COMMANDS
    if suggest:
        return "commenter+apply" if apply else "commenter"
    return "editor" if apply else "none"


def test_snapshot_covers_every_command_type() -> None:
    assert set(SNAPSHOT) == set(get_args(DocumentCommandType))
    assert len(SNAPSHOT) == 85


@pytest.mark.parametrize("command_type", sorted(SNAPSHOT))
def test_command_type_payload_handler_and_access(command_type: str) -> None:
    payload, handler, access = SNAPSHOT[command_type]
    assert _PAYLOAD_BY_TYPE[command_type].__name__ == payload
    assert _handler_name(HANDLERS[command_type]) == handler
    assert _access(command_type) == access


def test_role_sets_are_exactly_the_snapshot() -> None:
    by_access = {
        a: {t for t, (_, _, acc) in SNAPSHOT.items() if acc == a}
        for a in ("host", "comment", "commenter", "commenter+apply", "editor")
    }
    assert by_access["host"] == caps.HOST_ONLY_DOCUMENT_COMMANDS
    assert by_access["comment"] == caps.COMMENT_COMMANDS
    assert by_access["commenter"] | by_access["commenter+apply"] == caps.SUGGEST_COMMANDS
    assert by_access["commenter+apply"] | by_access["editor"] == caps.EDIT_COMMANDS
    assert {"SplitAtTime", "DeleteClip"} == caps.STRUCTURAL_COMMANDS
    assert caps.ROLE_DOCUMENT_COMMANDS[ReviewRole.VIEWER] == frozenset()
    assert caps.ROLE_DOCUMENT_COMMANDS[ReviewRole.COMMENTER] == caps.SUGGEST_COMMANDS
    assert caps.ROLE_DOCUMENT_COMMANDS[ReviewRole.EDITOR] == (
        caps.EDIT_COMMANDS | caps.SUGGEST_COMMANDS
    )
