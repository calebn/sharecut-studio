"""CommentService - timeline review comments via ProjectWorkspace.mutate."""

from __future__ import annotations

import builtins
import functools
from collections.abc import Callable
from typing import Any, TypeVar

from podcast_mcp.edits.comments import (
    add_action_item,
    add_comment,
    add_reply,
    delete_comment,
    get_comment,
    list_comments,
    resolve_comment,
    set_action_item_done,
    update_comment,
)
from podcast_mcp.models.episode import RangeInterval, TimelineComment
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.comment_results import (
    CommentActionItemResult,
    CommentDeletedResult,
    CommentReplyResult,
)
from podcast_mcp.util.coded_error import CodedKeyError
from podcast_mcp.util.project_state import FileRevision

T = TypeVar("T")
F = TypeVar("F", bound=Callable[..., Any])


def with_comment_write_grant(fn: F) -> F:
    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with write_grant(WriteGrantKind.LEGACY_COMMENT):
            return fn(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def run_comment_mutation_with_file_revisions(
    ws: ProjectWorkspace,
    mutate: Callable[[], T],
) -> tuple[T, tuple[FileRevision | None, FileRevision | None, int | None]]:
    with write_grant(WriteGrantKind.LEGACY_COMMENT), ws.transaction():
        before = ws.loaded_file_revision
        result = mutate()
        after = ws.loaded_file_revision
        try:
            after_ctime_ns = ws.path.stat().st_ctime_ns
        except OSError:
            after_ctime_ns = None
    return result, (before, after, after_ctime_ns)


class CommentService:
    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws

    def list(
        self,
        *,
        include_resolved: bool = True,
        open_actions_only: bool = False,
    ) -> builtins.list[TimelineComment]:
        return list_comments(
            self.ws.project,
            include_resolved=include_resolved,
            open_actions_only=open_actions_only,
        )

    def get(self, comment_id: str) -> TimelineComment:
        return get_comment(self.ws.project, comment_id)

    def add(
        self,
        *,
        body: str,
        author: str,
        timeline_start: float,
        timeline_end: float | None = None,
        track_ids: builtins.list[str] | None = None,
        action_texts: builtins.list[str] | None = None,
        edit_decision_id: str | None = None,
        timeline_spans: builtins.list[RangeInterval] | None = None,
        comment_id: str | None = None,
        review_version_id: str | None = None,
    ) -> TimelineComment:
        def mutate(p) -> TimelineComment:
            comment = add_comment(
                p,
                body=body,
                author=author,
                timeline_start=timeline_start,
                timeline_end=timeline_end,
                timeline_spans=timeline_spans,
                track_ids=track_ids,
                action_texts=action_texts,
                edit_decision_id=edit_decision_id,
                comment_id=comment_id,
                review_version_id=review_version_id,
            )
            return comment

        return self.ws.mutate("before add comment", "after add comment", mutate)

    def update(
        self,
        comment_id: str,
        *,
        body: str | None = None,
        track_ids: builtins.list[str] | None = None,
        timeline_start: float | None = None,
        timeline_end: float | None = None,
    ) -> TimelineComment:
        def mutate(p) -> TimelineComment:
            comment = update_comment(
                p,
                comment_id,
                body=body,
                track_ids=track_ids,
                timeline_start=timeline_start,
                timeline_end=timeline_end,
            )
            return comment

        return self.ws.mutate("before update comment", "after update comment", mutate)

    def resolve(
        self,
        comment_id: str,
        *,
        by: str,
        resolved: bool = True,
    ) -> TimelineComment:
        def mutate(p) -> TimelineComment:
            comment = resolve_comment(p, comment_id, resolved=resolved, by=by)
            return comment

        label = "resolve" if resolved else "unresolve"
        return self.ws.mutate(
            f"before {label} comment",
            f"after {label} comment",
            mutate,
        )

    def delete(self, comment_id: str) -> CommentDeletedResult:
        def mutate(p) -> CommentDeletedResult:
            ok = delete_comment(p, comment_id)
            if not ok:
                raise CodedKeyError(f"comment not found: {comment_id}", code="comment_not_found")
            return CommentDeletedResult(deleted=True, id=comment_id)

        return self.ws.mutate("before delete comment", "after delete comment", mutate)

    def set_action_done(
        self,
        comment_id: str,
        action_id: str,
        *,
        done: bool,
        by: str,
    ) -> CommentActionItemResult:
        def mutate(p) -> CommentActionItemResult:
            item = set_action_item_done(p, comment_id, action_id, done=done, by=by)
            return CommentActionItemResult(comment_id=comment_id, action_item=item)

        return self.ws.mutate(
            "before comment action done",
            "after comment action done",
            mutate,
        )

    def add_action(self, comment_id: str, text: str) -> CommentActionItemResult:
        def mutate(p) -> CommentActionItemResult:
            item = add_action_item(p, comment_id, text)
            return CommentActionItemResult(comment_id=comment_id, action_item=item)

        return self.ws.mutate(
            "before add comment action",
            "after add comment action",
            mutate,
        )

    def add_reply(
        self,
        comment_id: str,
        *,
        body: str,
        author: str,
    ) -> CommentReplyResult:
        def mutate(p) -> CommentReplyResult:
            reply = add_reply(p, comment_id, body=body, author=author)
            return CommentReplyResult(comment_id=comment_id, reply=reply)

        return self.ws.mutate(
            "before add comment reply",
            "after add comment reply",
            mutate,
        )
