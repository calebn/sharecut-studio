from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    coded_http_error,
    host_gate_for_client,
    resolve_project,
)
from podcast_mcp.gui.schemas import (
    CommentActionDoneRequest,
    CommentCreateRequest,
    CommentPatchRequest,
    CommentReplyRequest,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import CommentService, run_comment_mutation_with_file_revisions
from podcast_mcp.services.document_sync import notify_comments_changed

router = APIRouter()
_HOST_GATE = [Depends(host_gate_for_client)]


@router.post("/api/comments", dependencies=_HOST_GATE)
def create_comment(
    req: CommentCreateRequest,
    request: Request,
) -> dict[str, Any]:
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
        raise coded_exception_error(400, exc, code="comment_invalid") from exc
    notify_comments_changed(path, file_revisions=file_revisions)
    return {"comment": comment.model_dump()}


@router.patch("/api/comments/{comment_id}", dependencies=_HOST_GATE)
def patch_comment(
    comment_id: str,
    req: CommentPatchRequest,
    request: Request,
) -> dict[str, Any]:
    path = resolve_project(req.path, request)
    ws = ProjectWorkspace.open(path)
    svc = CommentService(ws)
    mutated = True
    try:
        if req.resolved is not None:
            by = req.by
            if not by:
                raise coded_http_error(
                    400, "by is required when setting resolved", code="comment_resolver_required"
                )
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
        raise coded_exception_error(404, exc, code="comment_not_found") from exc
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="comment_invalid") from exc
    if mutated:
        notify_comments_changed(path, file_revisions=file_revisions)
    return {"comment": comment.model_dump()}


@router.post("/api/comments/{comment_id}/actions/{action_id}/done", dependencies=_HOST_GATE)
def action_done(
    comment_id: str,
    action_id: str,
    req: CommentActionDoneRequest,
    request: Request,
) -> dict[str, Any]:
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
        raise coded_exception_error(404, exc, code="comment_not_found") from exc
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="comment_invalid") from exc
    notify_comments_changed(path, file_revisions=file_revisions)
    return result.model_dump()


@router.post("/api/comments/{comment_id}/replies", dependencies=_HOST_GATE)
def create_reply(
    comment_id: str,
    req: CommentReplyRequest,
    request: Request,
) -> dict[str, Any]:
    path = resolve_project(req.path, request)
    ws = ProjectWorkspace.open(path)
    try:
        result, file_revisions = run_comment_mutation_with_file_revisions(
            ws,
            lambda: CommentService(ws).add_reply(comment_id, body=req.body, author=req.author),
        )
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="comment_not_found") from exc
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="comment_invalid") from exc
    notify_comments_changed(path, file_revisions=file_revisions)
    return result.model_dump()


@router.delete("/api/comments/{comment_id}", dependencies=_HOST_GATE)
def remove_comment(
    comment_id: str,
    request: Request,
    path: str,
) -> dict[str, Any]:
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        result, file_revisions = run_comment_mutation_with_file_revisions(
            ws, lambda: CommentService(ws).delete(comment_id)
        )
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="comment_not_found") from exc
    notify_comments_changed(project_path, file_revisions=file_revisions)
    return result.model_dump()
