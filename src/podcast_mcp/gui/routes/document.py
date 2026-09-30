"""Document commands, comments and atomic state over HTTP."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from filelock import Timeout

from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.gui.routes.deps import (
    peer_host,
    project_busy_http_error,
    require_authz,
    resolve_project,
)
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import DocumentCommandRequest
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import document_command_from_body
from podcast_mcp.util.proxy_paths import is_relayed_request

router = APIRouter()


@router.get("/api/document/comments")
def get_document_comments(
    request: Request,
    path: str = Query(...),
    client_id: str = Query("viewer"),
    role: str = Query("viewer"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(
        client_id=client_id,
        role=role,
        peer_host=peer_host(request),
        token=token or x_podcast_token,
        relayed=is_relayed_request(request.headers),
    )
    project_path = resolve_project(path, request)
    svc = DocumentSyncService.open(project_path)
    return svc.comments_snapshot()


@router.get("/api/document/state")
def get_document_state(
    request: Request,
    path: str = Query(...),
    phase: str = Query("shell", pattern="^(shell|detail|full)$"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(
        client_id="viewer",
        role="viewer",
        peer_host=peer_host(request),
        token=token or x_podcast_token,
        relayed=is_relayed_request(request.headers),
    )
    project_path = resolve_project(path, request)
    pin_served_if_allowed(request, project_path)
    return DocumentSyncService.open(project_path).document_snapshot(projection=phase)


@router.post("/api/document/command")
def post_document_command(
    body: DocumentCommandRequest,
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(
        client_id=body.client_id,
        role=body.role,
        peer_host=peer_host(request),
        token=token or x_podcast_token or body.token,
        relayed=is_relayed_request(request.headers),
    )
    project_path = resolve_project(path, request)
    svc = DocumentSyncService.open(project_path)
    cmd = document_command_from_body(body)
    try:
        return svc.submit(cmd, structural_mode=body.structural_mode)
    except DocumentConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={"detail": str(exc), "conflict": True},
        ) from exc
    except TranscriptRefineRequiredError as exc:
        raise HTTPException(
            status_code=409,
            detail=str(exc),
            headers={"X-Sharecut-Error-Code": "transcript_refine_required"},
        ) from exc
    except (Timeout, sqlite3.OperationalError) as exc:
        busy = project_busy_http_error(exc)
        if busy is None:
            raise
        raise busy from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
