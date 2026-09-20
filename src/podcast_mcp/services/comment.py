"""CommentService - timeline review comments via ProjectWorkspace.mutate."""

from __future__ import annotations

import builtins
from typing import Any

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
from podcast_mcp.services.workspace import ProjectWorkspace


class CommentService:
    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws

    def list(
        self,
        *,
        include_resolved: bool = True,
        open_actions_only: bool = False,
    ) -> builtins.list[dict[str, Any]]:
        return [
            c.model_dump()
            for c in list_comments(
                self.ws.project,
                include_resolved=include_resolved,
                open_actions_only=open_actions_only,
            )
        ]

    def get(self, comment_id: str) -> dict[str, Any]:
        return get_comment(self.ws.project, comment_id).model_dump()

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
        comment_id: str | None = None,
    ) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            comment = add_comment(
                p,
                body=body,
                author=author,
                timeline_start=timeline_start,
                timeline_end=timeline_end,
                track_ids=track_ids,
                action_texts=action_texts,
                edit_decision_id=edit_decision_id,
                comment_id=comment_id,
            )
            return comment.model_dump()

        return self.ws.mutate("before add comment", "after add comment", mutate)

    def update(
        self,
        comment_id: str,
        *,
        body: str | None = None,
        track_ids: builtins.list[str] | None = None,
        timeline_start: float | None = None,
        timeline_end: float | None = None,
    ) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            comment = update_comment(
                p,
                comment_id,
                body=body,
                track_ids=track_ids,
                timeline_start=timeline_start,
                timeline_end=timeline_end,
            )
            return comment.model_dump()

        return self.ws.mutate("before update comment", "after update comment", mutate)

    def resolve(
        self,
        comment_id: str,
        *,
        by: str,
        resolved: bool = True,
    ) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            comment = resolve_comment(p, comment_id, resolved=resolved, by=by)
            return comment.model_dump()

        label = "resolve" if resolved else "unresolve"
        return self.ws.mutate(
            f"before {label} comment",
            f"after {label} comment",
            mutate,
        )

    def delete(self, comment_id: str) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            ok = delete_comment(p, comment_id)
            if not ok:
                raise KeyError(f"comment not found: {comment_id}")
            return {"deleted": True, "id": comment_id}

        return self.ws.mutate("before delete comment", "after delete comment", mutate)

    def set_action_done(
        self,
        comment_id: str,
        action_id: str,
        *,
        done: bool,
        by: str,
    ) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            item = set_action_item_done(p, comment_id, action_id, done=done, by=by)
            return {
                "comment_id": comment_id,
                "action_item": item.model_dump(),
            }

        return self.ws.mutate(
            "before comment action done",
            "after comment action done",
            mutate,
        )

    def add_action(self, comment_id: str, text: str) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            item = add_action_item(p, comment_id, text)
            return {
                "comment_id": comment_id,
                "action_item": item.model_dump(),
            }

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
    ) -> dict[str, Any]:
        def mutate(p) -> dict[str, Any]:
            reply = add_reply(p, comment_id, body=body, author=author)
            return {
                "comment_id": comment_id,
                "reply": reply.model_dump(),
            }

        return self.ws.mutate(
            "before add comment reply",
            "after add comment reply",
            mutate,
        )
