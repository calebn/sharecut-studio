from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.document.align_accept import AlignAcceptService
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
    from podcast_mcp.services.document.edit import EditService
    from podcast_mcp.services.document.episode import EpisodeService
    from podcast_mcp.services.document.golden_ear import (
        DEFAULT_LIMIT,
        LISTEN_DIRNAME,
        build_golden_ear,
        score_golden_ear,
    )
    from podcast_mcp.services.document.history import HISTORY_RERENDER_ERRORS, HistoryService
    from podcast_mcp.services.document.play import PlayRequest, PlayService, TransportPath

__all__ = [
    "DEFAULT_LIMIT",
    "HISTORY_RERENDER_ERRORS",
    "LISTEN_DIRNAME",
    "AlignAcceptService",
    "BoundaryEdit",
    "BoundaryTarget",
    "ClipGeometry",
    "ClipService",
    "CommentService",
    "EditService",
    "EpisodeService",
    "HistoryService",
    "PlayRequest",
    "PlayService",
    "RollBoundaryTarget",
    "TransportPath",
    "TrimBoundaryTarget",
    "build_golden_ear",
    "cross_process_bridge",
    "cross_process_lease",
    "run_comment_mutation_with_file_revisions",
    "score_golden_ear",
]

_MODULE_BY_NAME = {
    "AlignAcceptService": "align_accept",
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
    "EditService": "edit",
    "EpisodeService": "episode",
    "DEFAULT_LIMIT": "golden_ear",
    "LISTEN_DIRNAME": "golden_ear",
    "build_golden_ear": "golden_ear",
    "score_golden_ear": "golden_ear",
    "HISTORY_RERENDER_ERRORS": "history",
    "HistoryService": "history",
    "PlayRequest": "play",
    "PlayService": "play",
    "TransportPath": "play",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
