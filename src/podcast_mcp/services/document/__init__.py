from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.document.align_accept import AlignAcceptService
    from podcast_mcp.services.document.analysis import AnalysisService
    from podcast_mcp.services.document.approval_warm import warm_in_background
    from podcast_mcp.services.document.boundary import (
        BoundaryEdit,
        BoundaryTarget,
        ClipGeometry,
        RollBoundaryTarget,
        TrimBoundaryTarget,
    )
    from podcast_mcp.services.document.clip import ClipService
    from podcast_mcp.services.document.comment import (
        CommentService,
        run_comment_mutation_with_file_revisions,
    )
    from podcast_mcp.services.document.cross_process_sync import (
        cross_process_bridge,
        cross_process_lease,
    )
    from podcast_mcp.services.document.edit import EditService, with_audio_check
    from podcast_mcp.services.document.episode import EpisodeService
    from podcast_mcp.services.document.export_files import (
        ExportedFile,
        ExportFilesService,
        ServedFile,
    )
    from podcast_mcp.services.document.feed import (
        SHOW_KEY,
        FeedService,
        FeedViewKind,
        describe_fields,
    )
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
        PopulatedHistoryDiffResult,
    )
    from podcast_mcp.services.document.play import PlayRequest, PlayService, TransportPath
    from podcast_mcp.services.document.play_pending import (
        PENDING_PREVIEW_PAD_DEFAULT_SEC,
        PENDING_PREVIEW_PAD_MAX_SEC,
        PENDING_PREVIEW_PAD_MIN_SEC,
        PendingPreviewSpan,
    )
    from podcast_mcp.services.document.session_suggestion import SessionSuggestionService
    from podcast_mcp.services.document.timeline import TimelineService
    from podcast_mcp.services.document.transcript import (
        ExportBusyError,
        TranscriptEmptyError,
        TranscriptService,
        TranscriptTimingChangedError,
        WordTimingTarget,
    )

__all__ = [
    "DEFAULT_LIMIT",
    "HISTORY_RERENDER_ERRORS",
    "LISTEN_DIRNAME",
    "PENDING_PREVIEW_PAD_DEFAULT_SEC",
    "PENDING_PREVIEW_PAD_MAX_SEC",
    "PENDING_PREVIEW_PAD_MIN_SEC",
    "SHOW_KEY",
    "AlignAcceptService",
    "AnalysisService",
    "BoundaryEdit",
    "BoundaryTarget",
    "ClipGeometry",
    "ClipService",
    "CommentService",
    "EditService",
    "EmptyHistoryDiffResult",
    "EpisodeService",
    "ExportBusyError",
    "ExportFilesService",
    "ExportedFile",
    "FeedService",
    "FeedViewKind",
    "HistoryDiffResult",
    "HistoryListResult",
    "HistoryService",
    "PendingPreviewSpan",
    "PlayRequest",
    "PlayService",
    "PopulatedHistoryDiffResult",
    "RollBoundaryTarget",
    "ServedFile",
    "SessionSuggestionService",
    "TimelineService",
    "TranscriptEmptyError",
    "TranscriptService",
    "TranscriptTimingChangedError",
    "TransportPath",
    "TrimBoundaryTarget",
    "WordTimingTarget",
    "build_golden_ear",
    "cross_process_bridge",
    "cross_process_lease",
    "describe_fields",
    "run_comment_mutation_with_file_revisions",
    "score_golden_ear",
    "warm_in_background",
    "with_audio_check",
]

_MODULE_BY_NAME = {
    "AlignAcceptService": "align_accept",
    "AnalysisService": "analysis",
    "BoundaryEdit": "boundary",
    "BoundaryTarget": "boundary",
    "ClipGeometry": "boundary",
    "RollBoundaryTarget": "boundary",
    "TrimBoundaryTarget": "boundary",
    "ClipService": "clip",
    "CommentService": "comment",
    "run_comment_mutation_with_file_revisions": "comment",
    "cross_process_bridge": "cross_process_sync",
    "cross_process_lease": "cross_process_sync",
    "warm_in_background": "approval_warm",
    "EditService": "edit",
    "with_audio_check": "edit",
    "EpisodeService": "episode",
    "ExportFilesService": "export_files",
    "ExportedFile": "export_files",
    "ServedFile": "export_files",
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
    "PopulatedHistoryDiffResult": "history_results",
    "PENDING_PREVIEW_PAD_DEFAULT_SEC": "play_pending",
    "PENDING_PREVIEW_PAD_MAX_SEC": "play_pending",
    "PENDING_PREVIEW_PAD_MIN_SEC": "play_pending",
    "PendingPreviewSpan": "play_pending",
    "PlayRequest": "play",
    "PlayService": "play",
    "TransportPath": "play",
    "SessionSuggestionService": "session_suggestion",
    "TimelineService": "timeline",
    "TranscriptService": "transcript",
    "TranscriptEmptyError": "transcript",
    "ExportBusyError": "transcript",
    "TranscriptTimingChangedError": "transcript",
    "WordTimingTarget": "transcript",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
