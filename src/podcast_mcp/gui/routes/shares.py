"""Host share list/create/revoke HTTP adapters over ShareService."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.gui.schemas import (
    RecordRoomCreateRequest,
    RecordRoomRevokeRequest,
    ShareCreateRequest,
    ShareRevokeRequest,
)
from podcast_mcp.services import ProjectWorkspace, ShareService
from podcast_mcp.services.record.reducer import RecordStateError
from podcast_mcp.services.share_page import share_public_origin

router = APIRouter()


def _origin(request: Request) -> str:
    return share_public_origin(str(request.base_url))


@router.get("/api/shares")
def list_host_shares(
    path: str,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    origin = _origin(request)
    return {
        "shares": ShareService(ws).list_presented(public_base_url=origin),
        "public_origin": origin,
    }


@router.post("/api/shares")
def create_host_share(
    body: ShareCreateRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    origin = _origin(request)
    try:
        share = ShareService(ws).create_for_host(
            role=body.role,
            with_mcp=body.with_mcp,
            review_version_id=body.review_version_id,
            public_base_url=origin,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"share": share}


@router.post("/api/shares/{share_token}/revoke")
def revoke_host_share(
    share_token: str,
    body: ShareRevokeRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        return ShareService(ws).revoke(share_token)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/api/shares/record")
def create_host_record_room(
    body: RecordRoomCreateRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    origin = _origin(request)
    try:
        room = ShareService(ws).create_record_room(
            public_base_url=origin,
            expires_at=body.expires_at,
        )
    except RecordStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"room": room}


@router.post("/api/shares/rooms/{session_id}/revoke")
def revoke_host_record_room(
    session_id: str,
    body: RecordRoomRevokeRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        return ShareService(ws).revoke_room(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
