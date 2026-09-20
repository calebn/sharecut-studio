"""Document-plane comment command handlers."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.services.comment import CommentService
from podcast_mcp.services.workspace import ProjectWorkspace

Handler = Callable[[ProjectWorkspace, dict[str, Any]], dict[str, Any]]


def add_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).add(
        body=p["body"],
        author=p["author"],
        timeline_start=float(p["timeline_start"]),
        timeline_end=p.get("timeline_end"),
        track_ids=p.get("track_ids"),
        action_texts=p.get("action_texts"),
        edit_decision_id=p.get("edit_decision_id"),
    )


def update_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).update(
        p["comment_id"],
        body=p.get("body"),
        track_ids=p.get("track_ids"),
        timeline_start=p.get("timeline_start"),
        timeline_end=p.get("timeline_end"),
    )


def resolve_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).resolve(
        p["comment_id"],
        by=p["by"],
        resolved=bool(p.get("resolved", True)),
    )


def delete_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).delete(p["comment_id"])


def add_reply(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).add_reply(p["comment_id"], body=p["body"], author=p["author"])


def set_action_done(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).set_action_done(
        p["comment_id"],
        p["action_id"],
        done=bool(p.get("done", True)),
        by=p["by"],
    )


def add_action(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).add_action(p["comment_id"], p["text"])


HANDLERS: dict[str, Handler] = {
    "AddComment": add_comment,
    "UpdateComment": update_comment,
    "ResolveComment": resolve_comment,
    "DeleteComment": delete_comment,
    "AddReply": add_reply,
    "SetActionDone": set_action_done,
    "AddAction": add_action,
}
