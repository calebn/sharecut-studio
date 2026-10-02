from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.document.align_accept import AlignAcceptService
    from podcast_mcp.services.document.boundary import (
        BoundaryEdit,
        BoundaryTarget,
        ClipGeometry,
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
    from podcast_mcp.services.document.review_comments import (
        COMMENTS_SANITY_S,
        ReviewCommentsReplica,
        review_comments_locked,
    )

__all__ = [
    "COMMENTS_SANITY_S",
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
    "ReviewCommentsReplica",
    "TransportPath",
    "TrimBoundaryTarget",
    "build_golden_ear",
    "cross_process_bridge",
    "cross_process_lease",
    "review_comments_locked",
    "run_comment_mutation_with_file_revisions",
    "score_golden_ear",
]

_MODULE_BY_NAME = {
    "AlignAcceptService": "align_accept",
    "BoundaryEdit": "boundary",
    "BoundaryTarget": "boundary",
    "ClipGeometry": "boundary",
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
    "COMMENTS_SANITY_S": "review_comments",
    "ReviewCommentsReplica": "review_comments",
    "review_comments_locked": "review_comments",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
