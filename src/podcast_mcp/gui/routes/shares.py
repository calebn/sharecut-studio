"""Host share list/create/revoke HTTP adapters over ShareService."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    coded_http_error,
    resolve_project,
)
from podcast_mcp.gui.schemas import (
    RecordInviteReplaceRequest,
    RecordRoomCreateRequest,
    RecordRoomRestoreRequest,
    RecordRoomRevokeRequest,
    RoomRestoreResponse,
    RoomRevokeResponse,
    ShareCreateRequest,
    ShareRestoreRequest,
    ShareRestoreResponse,
    ShareRevokeRequest,
    ShareRevokeResponse,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import (
    MixUnavailableError,
    RecordRoomConflictError,
    RecordStaleLinksError,
    RestoreWindowClosedError,
    ShareExpiredError,
    ShareService,
    share_public_origin,
)
from podcast_mcp.services.record import RecordLandingError, RecordStateError

router = APIRouter()

RESTORABLE_REVOKE_SEC = 10.0


def _origin(request: Request) -> str:
    return share_public_origin(str(request.base_url))


def _restore_ms(restorable_until: str | None) -> int | None:
    if restorable_until is None:
        return None
    left = datetime.fromisoformat(restorable_until) - datetime.now(UTC)
    return max(0, int(left.total_seconds() * 1000))


def _restore_refusal(
    exc: RestoreWindowClosedError | ShareExpiredError | RecordRoomConflictError,
) -> HTTPException:
    status = 409 if isinstance(exc, RecordRoomConflictError) else 410
    return coded_http_error(status, str(exc), code=exc.code)


@router.get("/api/shares")
def list_host_shares(
    path: str,
    request: Request,
) -> dict[str, Any]:
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
) -> dict[str, Any]:
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


@router.post(
    "/api/shares/{share_token}/revoke",
    response_model=ShareRevokeResponse,
    response_model_exclude_none=True,
)
def revoke_host_share(
    share_token: str,
    body: ShareRevokeRequest,
    request: Request,
) -> ShareRevokeResponse:
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        out = ShareService(ws).revoke(
            share_token, restorable_for=RESTORABLE_REVOKE_SEC if body.restorable else None
        )
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="share_not_found") from exc
    until = out.get("restorable_until")
    return ShareRevokeResponse(
        revoked=bool(out["revoked"]),
        token=str(out["token"]),
        restorable_until=until,
        restore_ms=_restore_ms(until),
    )


@router.post("/api/shares/{share_token}/restore", response_model=ShareRestoreResponse)
def restore_host_share(
    share_token: str,
    body: ShareRestoreRequest,
    request: Request,
) -> ShareRestoreResponse:
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        out = ShareService(ws).restore(share_token)
    except (RestoreWindowClosedError, ShareExpiredError) as exc:
        raise _restore_refusal(exc) from exc
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="share_not_found") from exc
    return ShareRestoreResponse(restored=out["restored"], token=out["token"])


@router.post("/api/shares/record")
def create_host_record_room(
    body: RecordRoomCreateRequest,
    request: Request,
) -> dict[str, Any]:
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    origin = _origin(request)
    try:
        room = ShareService(ws).create_record_room(
            public_base_url=origin,
            expires_at=body.expires_at,
            target=body.target,
            land_first=body.land_first,
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
    except RecordLandingError as exc:
        raise coded_exception_error(400, exc, code="record_land_refused") from exc
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="record_room_request_invalid") from exc
    return {"room": room}


@router.post("/api/shares/record/{source_token}/replace")
def replace_host_record_invite(
    source_token: str,
    body: RecordInviteReplaceRequest,
    request: Request,
) -> dict[str, Any]:
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


@router.post(
    "/api/shares/rooms/{session_id}/revoke",
    response_model=RoomRevokeResponse,
    response_model_exclude_none=True,
)
def revoke_host_record_room(
    session_id: str,
    body: RecordRoomRevokeRequest,
    request: Request,
) -> RoomRevokeResponse:
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        out = ShareService(ws).revoke_room(
            session_id, restorable_for=RESTORABLE_REVOKE_SEC if body.restorable else None
        )
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="record_room_not_found") from exc
    until = out.get("restorable_until")
    return RoomRevokeResponse(
        session_id=str(out["session_id"]),
        revoked=[str(t) for t in out["revoked"]],
        restorable_until=until,
        restore_ms=_restore_ms(until),
    )


@router.post("/api/shares/rooms/{session_id}/restore", response_model=RoomRestoreResponse)
def restore_host_record_room(
    session_id: str,
    body: RecordRoomRestoreRequest,
    request: Request,
) -> RoomRestoreResponse:
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        out = ShareService(ws).restore_room(session_id)
    except (RestoreWindowClosedError, ShareExpiredError, RecordRoomConflictError) as exc:
        raise _restore_refusal(exc) from exc
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="record_room_not_found") from exc
    return RoomRestoreResponse(session_id=out["session_id"], restored=list(out["restored"]))
