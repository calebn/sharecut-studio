"""Host share list/create/revoke HTTP adapters over ShareService."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    coded_http_error,
    require_host,
    resolve_project,
)
from podcast_mcp.gui.schemas import (
    RecordInviteReplaceRequest,
    RecordRoomCreateRequest,
    RecordRoomRevokeRequest,
    ShareCreateRequest,
    ShareRevokeRequest,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import (
    MixUnavailableError,
    RecordStaleLinksError,
    ShareService,
    share_public_origin,
)
from podcast_mcp.services.record import RecordStateError

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
            freeze=body.freeze,
            public_base_url=origin,
        )
    except MixUnavailableError as exc:
        raise coded_http_error(409, str(exc), code=exc.code) from exc
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="share_create_invalid") from exc
    except KeyError as exc:
        raise coded_exception_error(400, exc, code="share_create_target_unknown") from exc
    except FileNotFoundError as exc:
        raise coded_exception_error(400, exc, code="share_create_media_missing") from exc
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
        raise coded_exception_error(404, exc, code="share_not_found") from exc


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
            target=body.target,
        )
    except RecordStaleLinksError as exc:
        detail = {
            "error": exc.code,
            "message": str(exc),
            "room": exc.room,
            "stale_session_ids": exc.stale_session_ids,
        }
        raise coded_http_error(409, detail, code=exc.code) from exc
    except RecordStateError as exc:
        raise coded_exception_error(409, exc, code="record_room_unavailable") from exc
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="record_room_request_invalid") from exc
    return {"room": room}


@router.post("/api/shares/record/{source_token}/replace")
def replace_host_record_invite(
    source_token: str,
    body: RecordInviteReplaceRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        share = ShareService(ws).replace_closed_record_invite(
            source_token,
            public_base_url=_origin(request),
        )
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="share_not_found") from exc
    except RecordStateError as exc:
        raise coded_exception_error(409, exc, code="record_invite_replace_refused") from exc
    return {"share": share}


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
        raise coded_exception_error(404, exc, code="record_room_not_found") from exc
