"""Timeline review comments (session-clock feedback + action items)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from podcast_mcp.models import (
    CommentActionItem,
    CommentReply,
    EpisodeProject,
    TimelineComment,
)

COMMENT_BODY_MAX = 8000


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _require_body(text: str, *, kind: str = "comment") -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        raise ValueError(f"{kind} body is required")
    if len(cleaned) > COMMENT_BODY_MAX:
        raise ValueError(f"{kind} body exceeds {COMMENT_BODY_MAX} characters")
    return cleaned


def _normalize_end(start: float, end: float | None) -> float | None:
    if end is None:
        return None
    if end < start:
        raise ValueError("timeline_end must be >= timeline_start")
    if abs(end - start) < 1e-9:
        return None
    return end


def _validate_tracks(project: EpisodeProject, track_ids: list[str]) -> list[str]:
    known = {t.id for t in project.tracks}
    missing = [tid for tid in track_ids if tid not in known]
    if missing:
        raise ValueError(f"unknown track_id(s): {', '.join(missing)}")
    # Preserve order, drop duplicates
    seen: set[str] = set()
    out: list[str] = []
    for tid in track_ids:
        if tid not in seen:
            seen.add(tid)
            out.append(tid)
    return out


def comment_for_edit_decision(
    project: EpisodeProject, edit_decision_id: str
) -> TimelineComment | None:
    for comment in project.comments:
        if comment.edit_decision_id == edit_decision_id:
            return comment
    return None


def _validate_edit_decision_link(
    project: EpisodeProject, edit_decision_id: str | None
) -> str | None:
    if not edit_decision_id:
        return None
    pending_ids = {e.id for e in project.edit_decisions}
    if edit_decision_id not in pending_ids:
        raise ValueError(f"no pending edit decision: {edit_decision_id}")
    existing = comment_for_edit_decision(project, edit_decision_id)
    if existing is not None:
        raise ValueError(
            f"edit decision {edit_decision_id} already has a comment thread "
            f"({existing.id}); reply instead"
        )
    return edit_decision_id


def add_comment(
    project: EpisodeProject,
    *,
    body: str,
    author: str,
    timeline_start: float,
    timeline_end: float | None = None,
    track_ids: list[str] | None = None,
    action_texts: list[str] | None = None,
    edit_decision_id: str | None = None,
    comment_id: str | None = None,
) -> TimelineComment:
    text = _require_body(body)
    who = (author or "").strip()
    if not who:
        raise ValueError("author is required")
    if timeline_start < 0:
        raise ValueError("timeline_start must be >= 0")

    cid = (comment_id or "").strip() or _new_id()
    if comment_id:
        existing = next((item for item in project.comments if item.id == cid), None)
        if existing is not None:
            if existing.author != who:
                raise ValueError("comment id already exists")
            return existing

    end = _normalize_end(timeline_start, timeline_end)
    tracks = _validate_tracks(project, list(track_ids or []))
    linked = _validate_edit_decision_link(project, edit_decision_id)
    items = [
        CommentActionItem(id=_new_id(), text=t.strip())
        for t in (action_texts or [])
        if t and t.strip()
    ]
    created = _now_iso()
    comment = TimelineComment(
        id=cid,
        body=text,
        author=who,
        created_at=created,
        timeline_start=timeline_start,
        timeline_end=end,
        track_ids=tracks,
        action_items=items,
        review_version_id=project.review.active_version_id,
        edit_decision_id=linked,
    )
    project.comments.append(comment)
    project.comments.sort(key=lambda c: (c.timeline_start, c.created_at))
    return comment


def list_comments(
    project: EpisodeProject,
    *,
    include_resolved: bool = True,
    open_actions_only: bool = False,
) -> list[TimelineComment]:
    rows = list(project.comments)
    if not include_resolved:
        rows = [c for c in rows if not c.resolved]
    if open_actions_only:
        rows = [c for c in rows if any(not item.done for item in c.action_items)]
    rows.sort(key=lambda c: (c.timeline_start, c.created_at))
    return rows


def get_comment(project: EpisodeProject, comment_id: str) -> TimelineComment:
    for comment in project.comments:
        if comment.id == comment_id:
            return comment
    raise KeyError(f"comment not found: {comment_id}")


def update_comment(
    project: EpisodeProject,
    comment_id: str,
    *,
    body: str | None = None,
    track_ids: list[str] | None = None,
    timeline_start: float | None = None,
    timeline_end: float | None = None,
) -> TimelineComment:
    comment = get_comment(project, comment_id)
    if body is not None:
        comment.body = _require_body(body)
    if track_ids is not None:
        comment.track_ids = _validate_tracks(project, track_ids)
    if timeline_start is not None:
        if timeline_start < 0:
            raise ValueError("timeline_start must be >= 0")
        comment.timeline_start = timeline_start
    if timeline_end is not None or timeline_start is not None:
        end_val = timeline_end if timeline_end is not None else comment.timeline_end
        comment.timeline_end = _normalize_end(comment.timeline_start, end_val)
    comment.updated_at = _now_iso()
    project.comments.sort(key=lambda c: (c.timeline_start, c.created_at))
    return comment


def resolve_comment(
    project: EpisodeProject,
    comment_id: str,
    *,
    resolved: bool = True,
    by: str,
) -> TimelineComment:
    who = (by or "").strip()
    if not who:
        raise ValueError("resolved_by / by is required")
    comment = get_comment(project, comment_id)
    comment.resolved = resolved
    if resolved:
        comment.resolved_at = _now_iso()
        comment.resolved_by = who
    else:
        comment.resolved_at = None
        comment.resolved_by = None
    comment.updated_at = _now_iso()
    return comment


def delete_comment(project: EpisodeProject, comment_id: str) -> bool:
    before = len(project.comments)
    project.comments = [c for c in project.comments if c.id != comment_id]
    return len(project.comments) < before


def set_action_item_done(
    project: EpisodeProject,
    comment_id: str,
    action_id: str,
    *,
    done: bool,
    by: str,
) -> CommentActionItem:
    who = (by or "").strip()
    if not who:
        raise ValueError("completed_by / by is required")
    comment = get_comment(project, comment_id)
    for item in comment.action_items:
        if item.id == action_id:
            item.done = done
            if done:
                item.completed_at = _now_iso()
                item.completed_by = who
            else:
                item.completed_at = None
                item.completed_by = None
            comment.updated_at = _now_iso()
            return item
    raise KeyError(f"action item not found: {action_id}")


def add_action_item(
    project: EpisodeProject,
    comment_id: str,
    text: str,
) -> CommentActionItem:
    body = (text or "").strip()
    if not body:
        raise ValueError("action item text is required")
    comment = get_comment(project, comment_id)
    item = CommentActionItem(id=_new_id(), text=body)
    comment.action_items.append(item)
    comment.updated_at = _now_iso()
    return item


def add_reply(
    project: EpisodeProject,
    comment_id: str,
    *,
    body: str,
    author: str,
) -> CommentReply:
    text = _require_body(body, kind="reply")
    who = (author or "").strip()
    if not who:
        raise ValueError("author is required")
    comment = get_comment(project, comment_id)
    reply = CommentReply(
        id=_new_id(),
        body=text,
        author=who,
        created_at=_now_iso(),
    )
    comment.replies.append(reply)
    comment.updated_at = _now_iso()
    return reply


def comments_for_view(project: EpisodeProject) -> list[dict[str, Any]]:
    return [c.model_dump() for c in list_comments(project)]
