"""Document-plane comment command handlers."""

from __future__ import annotations

from typing import Any

from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import CommentService


def add_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        CommentService(ws)
        .add(
            body=p["body"],
            author=p["author"],
            timeline_start=float(p["timeline_start"]),
            timeline_end=p.get("timeline_end"),
            timeline_spans=[RangeInterval.model_validate(r) for r in p.get("timeline_spans") or []],
            track_ids=p.get("track_ids"),
            action_texts=p.get("action_texts"),
            edit_decision_id=p.get("edit_decision_id"),
        )
        .model_dump()
    )


def update_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        CommentService(ws)
        .update(
            p["comment_id"],
            body=p.get("body"),
            track_ids=p.get("track_ids"),
            timeline_start=p.get("timeline_start"),
            timeline_end=p.get("timeline_end"),
        )
        .model_dump()
    )


def resolve_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        CommentService(ws)
        .resolve(
            p["comment_id"],
            by=p["by"],
            resolved=bool(p.get("resolved", True)),
        )
        .model_dump()
    )


def delete_comment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).delete(p["comment_id"]).model_dump()


def add_reply(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        CommentService(ws)
        .add_reply(p["comment_id"], body=p["body"], author=p["author"])
        .model_dump()
    )


def set_action_done(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        CommentService(ws)
        .set_action_done(
            p["comment_id"],
            p["action_id"],
            done=bool(p.get("done", True)),
            by=p["by"],
        )
        .model_dump()
    )


def add_action(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return CommentService(ws).add_action(p["comment_id"], p["text"]).model_dump()
