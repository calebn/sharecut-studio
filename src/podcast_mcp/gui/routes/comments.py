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
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import CommentService
from podcast_mcp.services.document.comment import run_comment_mutation_with_file_revisions
from podcast_mcp.services.document_sync import notify_comments_changed

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
        comment, file_revisions = run_comment_mutation_with_file_revisions(
            ws,
            lambda: CommentService(ws).add(
                body=req.body,
                author=req.author,
                timeline_start=req.timeline_start,
                timeline_end=req.timeline_end,
                track_ids=req.track_ids or None,
                action_texts=req.action_texts or None,
                edit_decision_id=req.edit_decision_id,
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    notify_comments_changed(path, file_revisions=file_revisions)
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
    mutated = True
    try:
        if req.resolved is not None:
            by = req.by
            if not by:
                raise HTTPException(status_code=400, detail="by is required when setting resolved")
            resolved = req.resolved
            assert resolved is not None
            comment, file_revisions = run_comment_mutation_with_file_revisions(
                ws,
                lambda: svc.resolve(comment_id, by=by, resolved=resolved),
            )
        elif (
            req.body is not None
            or req.track_ids is not None
            or req.timeline_start is not None
            or req.timeline_end is not None
        ):
            comment, file_revisions = run_comment_mutation_with_file_revisions(
                ws,
                lambda: svc.update(
                    comment_id,
                    body=req.body,
                    track_ids=req.track_ids,
                    timeline_start=req.timeline_start,
                    timeline_end=req.timeline_end,
                ),
            )
        else:
            comment = svc.get(comment_id)
            mutated = False  # read-only PATCH: nothing to journal
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if mutated:
        notify_comments_changed(path, file_revisions=file_revisions)
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
        result, file_revisions = run_comment_mutation_with_file_revisions(
            ws,
            lambda: CommentService(ws).set_action_done(
                comment_id, action_id, done=req.done, by=req.by
            ),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    notify_comments_changed(path, file_revisions=file_revisions)
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
        result, file_revisions = run_comment_mutation_with_file_revisions(
            ws,
            lambda: CommentService(ws).add_reply(comment_id, body=req.body, author=req.author),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    notify_comments_changed(path, file_revisions=file_revisions)
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
        result, file_revisions = run_comment_mutation_with_file_revisions(
            ws, lambda: CommentService(ws).delete(comment_id)
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    notify_comments_changed(project_path, file_revisions=file_revisions)
    return result
