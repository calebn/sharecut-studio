from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.gui.schemas import (
    CommentActionDoneRequest,
    CommentCreateRequest,
    CommentPatchRequest,
    CommentReplyRequest,
)
from podcast_mcp.services import CommentService, ProjectWorkspace
from podcast_mcp.services.document_sync.service import notify_comments_changed

router = APIRouter()


@router.post("/api/comments")
def create_comment(
    req: CommentCreateRequest,
    request: Request,
    client_id: str = Query("viewer"),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, client_id=client_id, x_podcast_token=x_podcast_token)
    path = resolve_project(req.path, request)
    ws = ProjectWorkspace.open(path)
    try:
        comment = CommentService(ws).add(
            body=req.body,
            author=req.author,
            timeline_start=req.timeline_start,
            timeline_end=req.timeline_end,
            track_ids=req.track_ids or None,
            action_texts=req.action_texts or None,
            edit_decision_id=req.edit_decision_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    notify_comments_changed(path)
    return {"comment": comment}


@router.patch("/api/comments/{comment_id}")
def patch_comment(
    comment_id: str,
    req: CommentPatchRequest,
    request: Request,
    client_id: str = Query("viewer"),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, client_id=client_id, x_podcast_token=x_podcast_token)
    path = resolve_project(req.path, request)
    ws = ProjectWorkspace.open(path)
    svc = CommentService(ws)
    try:
        if req.resolved is not None:
            if not req.by:
                raise HTTPException(status_code=400, detail="by is required when setting resolved")
            comment = svc.resolve(comment_id, by=req.by, resolved=req.resolved)
        elif (
            req.body is not None
            or req.track_ids is not None
            or req.timeline_start is not None
            or req.timeline_end is not None
        ):
            comment = svc.update(
                comment_id,
                body=req.body,
                track_ids=req.track_ids,
                timeline_start=req.timeline_start,
                timeline_end=req.timeline_end,
            )
        else:
            comment = svc.get(comment_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    notify_comments_changed(path)
    return {"comment": comment}


@router.post("/api/comments/{comment_id}/actions/{action_id}/done")
def action_done(
    comment_id: str,
    action_id: str,
    req: CommentActionDoneRequest,
    request: Request,
    client_id: str = Query("viewer"),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, client_id=client_id, x_podcast_token=x_podcast_token)
    path = resolve_project(req.path, request)
    ws = ProjectWorkspace.open(path)
    try:
        result = CommentService(ws).set_action_done(comment_id, action_id, done=req.done, by=req.by)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    notify_comments_changed(path)
    return result


@router.post("/api/comments/{comment_id}/replies")
def create_reply(
    comment_id: str,
    req: CommentReplyRequest,
    request: Request,
    client_id: str = Query("viewer"),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, client_id=client_id, x_podcast_token=x_podcast_token)
    path = resolve_project(req.path, request)
    ws = ProjectWorkspace.open(path)
    try:
        result = CommentService(ws).add_reply(comment_id, body=req.body, author=req.author)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    notify_comments_changed(path)
    return result


@router.delete("/api/comments/{comment_id}")
def remove_comment(
    comment_id: str,
    request: Request,
    path: str,
    client_id: str = Query("viewer"),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, client_id=client_id, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        result = CommentService(ws).delete(comment_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    notify_comments_changed(project_path)
    return result
