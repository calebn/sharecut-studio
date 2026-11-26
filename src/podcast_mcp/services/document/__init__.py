from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.document.align_accept import AlignAcceptService
    from podcast_mcp.services.document.analysis import AnalysisService
    from podcast_mcp.services.document.approval_warm import (
        queue_room_tone_pools,
        warm_in_background,
    )
    from podcast_mcp.services.document.boundary import (
        BoundaryEdit,
        BoundaryTarget,
        ClipGeometry,
        RollBoundaryTarget,
        TrimBoundaryTarget,
    )
    from podcast_mcp.services.document.chapter_results import DeletedChapter, RemovedChapter
    from podcast_mcp.services.document.clip import ClipService
    from podcast_mcp.services.document.clip_fade_results import SetClipFadeResult
    from podcast_mcp.services.document.clipboard_results import (
        ClipboardExtract,
        ClipboardResult,
    )
    from podcast_mcp.services.document.comment import (
        CommentService,
        run_comment_mutation_with_file_revisions,
        with_comment_write_grant,
    )
    from podcast_mcp.services.document.comment_results import CommentReplyResult
    from podcast_mcp.services.document.cross_process_sync import (
        cross_process_bridge,
        cross_process_lease,
    )
    from podcast_mcp.services.document.edit import EditService, with_audio_check
    from podcast_mcp.services.document.episode import EpisodeService
    from podcast_mcp.services.document.export_files import (
        ArchivePlan,
        ExportedFile,
        ExportFilesService,
        ListedFiles,
        ServedFile,
        plan_archive,
    )
    from podcast_mcp.services.document.fade_recommendation_results import (
        AppliedFadeRecommendations,
        AppliedFadeUpdates,
    )
    from podcast_mcp.services.document.feed import (
        SHOW_KEY,
        FeedService,
        FeedViewKind,
        describe_fields,
    )
    from podcast_mcp.services.document.feed_results import FeedFieldPinResult
    from podcast_mcp.services.document.golden_ear import (
        DEFAULT_LIMIT,
        LISTEN_DIRNAME,
        build_golden_ear,
        score_golden_ear,
    )
    from podcast_mcp.services.document.history import HISTORY_RERENDER_ERRORS, HistoryService
    from podcast_mcp.services.document.history_results import (
        EmptyHistoryDiffResult,
        HistoryDiffResult,
        HistoryListResult,
        HistoryMoveRerenderedResult,
        HistoryMoveResult,
        PopulatedHistoryDiffResult,
    )
    from podcast_mcp.services.document.join_fade_results import (
        CrossfadeJoinsResult,
        FadeJoinsResult,
    )
    from podcast_mcp.services.document.join_mode_results import (
        SetClipJoinResult,
        SetJoinModeResult,
    )
    from podcast_mcp.services.document.join_quality_results import (
        JoinDetectorRow,
        JoinQualityReport,
        JoinQualityRow,
        JoinQualitySweep,
        JoinRankerVerdict,
    )
    from podcast_mcp.services.document.join_results import (
        JoinLabelResult,
        JoinTrainResult,
    )
    from podcast_mcp.services.document.kit_apply import KitApplyReport, submit_kit_apply
    from podcast_mcp.services.document.kit_offer import report_kit_offer
    from podcast_mcp.services.document.off_speaker_results import (
        OffSpeakerApplied,
        OffSpeakerPreview,
        OffSpeakerSummary,
    )
    from podcast_mcp.services.document.overlap_results import OverlapDuplicateReport
    from podcast_mcp.services.document.play import PlayRequest, PlayService, TransportPath
    from podcast_mcp.services.document.play_pending import (
        PENDING_PREVIEW_PAD_DEFAULT_SEC,
        PENDING_PREVIEW_PAD_MAX_SEC,
        PENDING_PREVIEW_PAD_MIN_SEC,
        PendingPreviewSpan,
    )
    from podcast_mcp.services.document.retained_bleed_results import (
        RetainedBleedAlignmentApplied,
        RetainedBleedAlignmentModeResult,
        RetainedBleedAlignmentPreview,
    )
    from podcast_mcp.services.document.roll_join_results import (
        RollAppliedResult,
        RollUnchangedResult,
    )
    from podcast_mcp.services.document.room_tone_bed import RoomToneBedReply, RoomToneBedService
    from podcast_mcp.services.document.segment_capture import parse_range, save_segment
    from podcast_mcp.services.document.segment_drift import report_segment_drift
    from podcast_mcp.services.document.segment_insert import (
        insert_saved_segment,
        preview_segment_insert,
        preview_segment_insert_on,
    )
    from podcast_mcp.services.document.segment_insert_results import (
        SegmentInsertApplied,
        SegmentInsertPreview,
    )
    from podcast_mcp.services.document.session_hear_results import (
        SESSION_HEAR_PUBLIC_EXCLUDE,
        SessionHearCurrentSide,
        SessionHearResult,
        SessionHearSuggestedSide,
    )
    from podcast_mcp.services.document.session_suggestion import SessionSuggestionService
    from podcast_mcp.services.document.shorten_word_gaps_results import (
        ShortenWordGapsApplied,
        ShortenWordGapsHeld,
        ShortenWordGapsUnchanged,
    )
    from podcast_mcp.services.document.split_results import (
        ProposeSplitResult,
        SplitAtTimeResult,
        SplitClipResult,
    )
    from podcast_mcp.services.document.strip_silence_results import StripSilenceResult
    from podcast_mcp.services.document.timeline import TimelineService
    from podcast_mcp.services.document.timeline_move_results import (
        InsertGapResult,
        MoveClipsResult,
        MoveSegmentResult,
    )
    from podcast_mcp.services.document.timeline_segment_results import (
        DuplicateSegmentResult,
        PasteSegmentResult,
    )
    from podcast_mcp.services.document.transcript import (
        ExportBusyError,
        TranscriptEmptyError,
        TranscriptReplacementMatch,
        TranscriptReplacementPreview,
        TranscriptService,
        TranscriptTimingChangedError,
        WordTimingChange,
        WordTimingContext,
        WordTimingTarget,
    )
    from podcast_mcp.services.document.transcript_flag_results import (
        WordAutomaticResult,
        WordsIgnoredResult,
        WordSuppressedResult,
    )
    from podcast_mcp.services.document.trim_edge_results import (
        TrimAppliedResult,
        TrimHeldResult,
        TrimUnchangedResult,
    )
    from podcast_mcp.services.document.warm_preview_results import WarmPreviewResult

__all__ = [
    "DEFAULT_LIMIT",
    "HISTORY_RERENDER_ERRORS",
    "LISTEN_DIRNAME",
    "PENDING_PREVIEW_PAD_DEFAULT_SEC",
    "PENDING_PREVIEW_PAD_MAX_SEC",
    "PENDING_PREVIEW_PAD_MIN_SEC",
    "SESSION_HEAR_PUBLIC_EXCLUDE",
    "SHOW_KEY",
    "AlignAcceptService",
    "AnalysisService",
    "AppliedFadeRecommendations",
    "AppliedFadeUpdates",
    "ArchivePlan",
    "BoundaryEdit",
    "BoundaryTarget",
    "ClipGeometry",
    "ClipService",
    "ClipboardExtract",
    "ClipboardResult",
    "CommentReplyResult",
    "CommentService",
    "CrossfadeJoinsResult",
    "DeletedChapter",
    "DuplicateSegmentResult",
    "EditService",
    "EmptyHistoryDiffResult",
    "EpisodeService",
    "ExportBusyError",
    "ExportFilesService",
    "ExportedFile",
    "FadeJoinsResult",
    "FeedFieldPinResult",
    "FeedService",
    "FeedViewKind",
    "HistoryDiffResult",
    "HistoryListResult",
    "HistoryMoveRerenderedResult",
    "HistoryMoveResult",
    "HistoryService",
    "InsertGapResult",
    "JoinDetectorRow",
    "JoinLabelResult",
    "JoinQualityReport",
    "JoinQualityRow",
    "JoinQualitySweep",
    "JoinRankerVerdict",
    "JoinTrainResult",
    "KitApplyReport",
    "ListedFiles",
    "MoveClipsResult",
    "MoveSegmentResult",
    "OffSpeakerApplied",
    "OffSpeakerPreview",
    "OffSpeakerSummary",
    "OverlapDuplicateReport",
    "PasteSegmentResult",
    "PendingPreviewSpan",
    "PlayRequest",
    "PlayService",
    "PopulatedHistoryDiffResult",
    "ProposeSplitResult",
    "RemovedChapter",
    "RetainedBleedAlignmentApplied",
    "RetainedBleedAlignmentModeResult",
    "RetainedBleedAlignmentPreview",
    "RollAppliedResult",
    "RollBoundaryTarget",
    "RollUnchangedResult",
    "RoomToneBedReply",
    "RoomToneBedService",
    "SegmentInsertApplied",
    "SegmentInsertPreview",
    "ServedFile",
    "SessionHearCurrentSide",
    "SessionHearResult",
    "SessionHearSuggestedSide",
    "SessionSuggestionService",
    "SetClipFadeResult",
    "SetClipJoinResult",
    "SetJoinModeResult",
    "ShortenWordGapsApplied",
    "ShortenWordGapsHeld",
    "ShortenWordGapsUnchanged",
    "SplitAtTimeResult",
    "SplitClipResult",
    "StripSilenceResult",
    "TimelineService",
    "TranscriptEmptyError",
    "TranscriptReplacementMatch",
    "TranscriptReplacementPreview",
    "TranscriptService",
    "TranscriptTimingChangedError",
    "TransportPath",
    "TrimAppliedResult",
    "TrimBoundaryTarget",
    "TrimHeldResult",
    "TrimUnchangedResult",
    "WarmPreviewResult",
    "WordAutomaticResult",
    "WordSuppressedResult",
    "WordTimingChange",
    "WordTimingContext",
    "WordTimingTarget",
    "WordsIgnoredResult",
    "build_golden_ear",
    "cross_process_bridge",
    "cross_process_lease",
    "describe_fields",
    "insert_saved_segment",
    "parse_range",
    "plan_archive",
    "preview_segment_insert",
    "preview_segment_insert_on",
    "queue_room_tone_pools",
    "report_kit_offer",
    "report_segment_drift",
    "run_comment_mutation_with_file_revisions",
    "save_segment",
    "score_golden_ear",
    "submit_kit_apply",
    "warm_in_background",
    "with_audio_check",
    "with_comment_write_grant",
]

_MODULE_BY_NAME = {
    "AlignAcceptService": "align_accept",
    "AnalysisService": "analysis",
    "AppliedFadeUpdates": "fade_recommendation_results",
    "AppliedFadeRecommendations": "fade_recommendation_results",
    "BoundaryEdit": "boundary",
    "BoundaryTarget": "boundary",
    "ClipGeometry": "boundary",
    "RollBoundaryTarget": "boundary",
    "TrimBoundaryTarget": "boundary",
    "ClipService": "clip",
    "CommentService": "comment",
    "CommentReplyResult": "comment_results",
    "run_comment_mutation_with_file_revisions": "comment",
    "cross_process_bridge": "cross_process_sync",
    "cross_process_lease": "cross_process_sync",
    "warm_in_background": "approval_warm",
    "queue_room_tone_pools": "approval_warm",
    "EditService": "edit",
    "with_audio_check": "edit",
    "with_comment_write_grant": "comment",
    "EpisodeService": "episode",
    "ExportFilesService": "export_files",
    "ExportedFile": "export_files",
    "ArchivePlan": "export_files",
    "ListedFiles": "export_files",
    "plan_archive": "export_files",
    "ServedFile": "export_files",
    "DeletedChapter": "chapter_results",
    "RemovedChapter": "chapter_results",
    "FeedFieldPinResult": "feed_results",
    "FeedService": "feed",
    "FeedViewKind": "feed",
    "SHOW_KEY": "feed",
    "describe_fields": "feed",
    "DEFAULT_LIMIT": "golden_ear",
    "LISTEN_DIRNAME": "golden_ear",
    "build_golden_ear": "golden_ear",
    "score_golden_ear": "golden_ear",
    "HISTORY_RERENDER_ERRORS": "history",
    "HistoryService": "history",
    "EmptyHistoryDiffResult": "history_results",
    "HistoryDiffResult": "history_results",
    "HistoryListResult": "history_results",
    "HistoryMoveRerenderedResult": "history_results",
    "HistoryMoveResult": "history_results",
    "PopulatedHistoryDiffResult": "history_results",
    "PENDING_PREVIEW_PAD_DEFAULT_SEC": "play_pending",
    "PENDING_PREVIEW_PAD_MAX_SEC": "play_pending",
    "PENDING_PREVIEW_PAD_MIN_SEC": "play_pending",
    "PendingPreviewSpan": "play_pending",
    "PlayRequest": "play",
    "PlayService": "play",
    "TransportPath": "play",
    "insert_saved_segment": "segment_insert",
    "submit_kit_apply": "kit_apply",
    "parse_range": "segment_capture",
    "preview_segment_insert": "segment_insert",
    "preview_segment_insert_on": "segment_insert",
    "SegmentInsertApplied": "segment_insert_results",
    "SegmentInsertPreview": "segment_insert_results",
    "KitApplyReport": "kit_apply",
    "save_segment": "segment_capture",
    "report_kit_offer": "kit_offer",
    "report_segment_drift": "segment_drift",
    "SessionSuggestionService": "session_suggestion",
    "RoomToneBedReply": "room_tone_bed",
    "RoomToneBedService": "room_tone_bed",
    "TimelineService": "timeline",
    "InsertGapResult": "timeline_move_results",
    "JoinDetectorRow": "join_quality_results",
    "JoinQualityReport": "join_quality_results",
    "JoinQualityRow": "join_quality_results",
    "JoinQualitySweep": "join_quality_results",
    "JoinRankerVerdict": "join_quality_results",
    "JoinLabelResult": "join_results",
    "JoinTrainResult": "join_results",
    "MoveClipsResult": "timeline_move_results",
    "MoveSegmentResult": "timeline_move_results",
    "DuplicateSegmentResult": "timeline_segment_results",
    "ClipboardExtract": "clipboard_results",
    "ClipboardResult": "clipboard_results",
    "OverlapDuplicateReport": "overlap_results",
    "PasteSegmentResult": "timeline_segment_results",
    "SetClipJoinResult": "join_mode_results",
    "SetClipFadeResult": "clip_fade_results",
    "FadeJoinsResult": "join_fade_results",
    "CrossfadeJoinsResult": "join_fade_results",
    "RollAppliedResult": "roll_join_results",
    "RollUnchangedResult": "roll_join_results",
    "SetJoinModeResult": "join_mode_results",
    "ShortenWordGapsApplied": "shorten_word_gaps_results",
    "ShortenWordGapsHeld": "shorten_word_gaps_results",
    "ShortenWordGapsUnchanged": "shorten_word_gaps_results",
    "SplitClipResult": "split_results",
    "SplitAtTimeResult": "split_results",
    "StripSilenceResult": "strip_silence_results",
    "OffSpeakerApplied": "off_speaker_results",
    "OffSpeakerPreview": "off_speaker_results",
    "OffSpeakerSummary": "off_speaker_results",
    "RetainedBleedAlignmentApplied": "retained_bleed_results",
    "RetainedBleedAlignmentModeResult": "retained_bleed_results",
    "RetainedBleedAlignmentPreview": "retained_bleed_results",
    "ProposeSplitResult": "split_results",
    "SESSION_HEAR_PUBLIC_EXCLUDE": "session_hear_results",
    "SessionHearCurrentSide": "session_hear_results",
    "SessionHearResult": "session_hear_results",
    "SessionHearSuggestedSide": "session_hear_results",
    "TrimAppliedResult": "trim_edge_results",
    "TrimHeldResult": "trim_edge_results",
    "TrimUnchangedResult": "trim_edge_results",
    "WarmPreviewResult": "warm_preview_results",
    "TranscriptService": "transcript",
    "TranscriptEmptyError": "transcript",
    "ExportBusyError": "transcript",
    "TranscriptReplacementMatch": "transcript",
    "TranscriptReplacementPreview": "transcript",
    "TranscriptTimingChangedError": "transcript",
    "WordTimingChange": "transcript",
    "WordTimingContext": "transcript",
    "WordTimingTarget": "transcript",
    "WordAutomaticResult": "transcript_flag_results",
    "WordSuppressedResult": "transcript_flag_results",
    "WordsIgnoredResult": "transcript_flag_results",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
