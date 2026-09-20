from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services import CommentService, ProjectWorkspace


def add_comment_tool(
    project_path: str,
    body: str,
    author: str,
    timeline_start: float,
    timeline_end: float | None = None,
    track_ids_json: str | None = None,
    action_texts_json: str | None = None,
    edit_decision_id: str | None = None,
) -> str:
    """Add a timeline review comment (instant or span).

    Times are **timeline seconds** (session/deliverable clock), like chapters -
    not source-media time. Use search_transcript_tool's timeline_start/end when
    anchoring to dialogue. track_ids_json / action_texts_json are JSON arrays of
    strings (optional). Empty track_ids = session-wide. Undoable via history.
    Pass edit_decision_id to open the single Ask thread for a pending cut
    (unique per decision; later notes must use add_comment_reply_tool).
    """
    ws = ProjectWorkspace.open(project_path)
    track_ids = json.loads(track_ids_json) if track_ids_json else None
    action_texts = json.loads(action_texts_json) if action_texts_json else None
    comment = CommentService(ws).add(
        body=body,
        author=author,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        track_ids=track_ids,
        action_texts=action_texts,
        edit_decision_id=edit_decision_id,
    )
    return to_json(comment)


def list_comments_tool(
    project_path: str,
    include_resolved: bool = True,
    open_actions_only: bool = False,
) -> str:
    """List timeline review comments sorted by timeline_start.

    Pass include_resolved=false for an agent work queue, or open_actions_only=true
    for incomplete action items. Each row includes id, body, author, track_ids,
    action_items, resolved_*.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(
        CommentService(ws).list(
            include_resolved=include_resolved,
            open_actions_only=open_actions_only,
        )
    )


def get_comment_tool(project_path: str, comment_id: str) -> str:
    """Fetch one timeline comment by id (full action_items and resolve metadata)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(CommentService(ws).get(comment_id))


def update_comment_tool(
    project_path: str,
    comment_id: str,
    body: str | None = None,
    track_ids_json: str | None = None,
    timeline_start: float | None = None,
    timeline_end: float | None = None,
) -> str:
    """Update comment body, tracks, and/or timeline anchor. Times are timeline seconds."""
    ws = ProjectWorkspace.open(project_path)
    track_ids = json.loads(track_ids_json) if track_ids_json is not None else None
    return to_json(
        CommentService(ws).update(
            comment_id,
            body=body,
            track_ids=track_ids,
            timeline_start=timeline_start,
            timeline_end=timeline_end,
        )
    )


def resolve_comment_tool(
    project_path: str,
    comment_id: str,
    by: str,
    resolved: bool = True,
) -> str:
    """Mark a comment resolved (or reopen with resolved=false).

    Always pass by= identity (e.g. \"agent\" or the human name). Records
    resolved_by / resolved_at. Prefer resolving after action items are done.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(CommentService(ws).resolve(comment_id, by=by, resolved=resolved))


def add_comment_action_tool(
    project_path: str,
    comment_id: str,
    text: str,
) -> str:
    """Append an action item TODO to an existing comment."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(CommentService(ws).add_action(comment_id, text))


def add_comment_reply_tool(
    project_path: str,
    comment_id: str,
    body: str,
    author: str,
) -> str:
    """Append a flat reply under an existing timeline comment (threaded discussion)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(CommentService(ws).add_reply(comment_id, body=body, author=author))


def set_comment_action_done_tool(
    project_path: str,
    comment_id: str,
    action_id: str,
    by: str,
    done: bool = True,
) -> str:
    """Check or uncheck a comment action item; records completed_by / completed_at.

    Agents should pass by=\"agent\" (or a stable agent label) when finishing work.
    """
    ws = ProjectWorkspace.open(project_path)
    return to_json(CommentService(ws).set_action_done(comment_id, action_id, done=done, by=by))


def delete_comment_tool(project_path: str, comment_id: str) -> str:
    """Delete a timeline review comment (undoable via history)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(CommentService(ws).delete(comment_id))


def register(mcp: MCPServer) -> None:
    """Register comment tools on the MCP server."""
    for fn in (
        add_comment_tool,
        list_comments_tool,
        get_comment_tool,
        update_comment_tool,
        resolve_comment_tool,
        add_comment_action_tool,
        add_comment_reply_tool,
        set_comment_action_done_tool,
        delete_comment_tool,
    ):
        mcp.tool()(fn)
