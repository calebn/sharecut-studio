"""Host-authenticated record session HTTP twins."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel, Field

from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    coded_http_error,
    require_host,
    resolve_project,
)
from podcast_mcp.gui.routes.record_upload_http import (
    ClippingParam,
    ClippingTruncatedParam,
    UploadKindParam,
    ingest_record_upload_request,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.record import (
    HOST_PARTICIPANT_ID,
    UPLOAD_KIND_ROOM_TONE,
    RecordAuthzError,
    RecordControlService,
    RecordLandingError,
    RecordSessionService,
    RecordStateError,
    RecordTakeOpenError,
    RecordUploadError,
    RecordUploadService,
    RoomFullError,
    parse_upload_kind,
    with_unlanded_takes,
)
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()


class RecordCommandBody(BaseModel):
    path: str
    command_type: str
    payload: dict[str, Any] = Field(default_factory=dict)


@router.get("/api/record/state")
def get_record_state(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    session_id = RecordSessionService.active_session_id(ws.project)
    if not session_id:
        raise coded_http_error(404, "no active record room", code="record_room_not_found")
    return with_unlanded_takes(
        ws.project, RecordSessionService(ws.project, session_id=session_id).snapshot()
    )


@router.post("/api/record/command")
def post_record_command(
    body: RecordCommandBody,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        ctrl = RecordControlService(ws)
    except FileNotFoundError as exc:
        raise coded_http_error(404, "no active record room", code="record_room_not_found") from exc
    try:
        return ctrl.submit_host(body.command_type, body.payload)
    except RecordAuthzError as exc:
        raise coded_exception_error(403, exc, code="record_command_not_allowed") from exc
    except (RecordStateError, RoomFullError, ValueError) as exc:
        raise coded_exception_error(400, exc, code="record_command_refused") from exc


def _host_upload(request: Request, path: str) -> tuple[RecordUploadService, str, ProjectWorkspace]:
    ws = ProjectWorkspace.open(resolve_project(path, request))
    session_id = RecordSessionService.active_session_id(ws.project)
    if not session_id:
        raise coded_http_error(404, "no active record room", code="record_room_not_found")
    return RecordUploadService(ws.project), session_id, ws


@router.get("/api/record/upload")
def get_host_record_upload(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    uploader, session_id, _ws = _host_upload(request, path)
    return uploader.status(session_id=session_id)


@router.post("/api/record/upload")
async def post_host_record_upload(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    take_index: int = Query(...),
    segment_index: int = Query(...),
    part_seq: int = Query(...),
    sha256: str = Query(""),
    file_sha256: str | None = Query(None),
    final: bool = Query(False),
    expected_parts: int | None = Query(None, ge=1),
    join_offset_ms: int | None = Query(None),
    clipping: ClippingParam = None,
    clipping_truncated: ClippingTruncatedParam = False,
    kind: UploadKindParam = None,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    uploader, session_id, ws = _host_upload(request, path)
    try:
        return await ingest_record_upload_request(
            request,
            uploader,
            session_id=session_id,
            participant_id=HOST_PARTICIPANT_ID,
            take_index=take_index,
            segment_index=segment_index,
            part_seq=part_seq,
            sha256=sha256,
            file_sha256=file_sha256,
            final=final,
            expected_parts=expected_parts,
            join_offset_ms=join_offset_ms,
            clipping=clipping,
            clipping_truncated=clipping_truncated,
            workspace=ws,
            kind=kind,
        )
    except RecordUploadError as exc:
        raise coded_exception_error(400, exc, code="record_upload_refused") from exc


@router.delete("/api/record/upload")
def delete_host_record_upload(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    kind: UploadKindParam = None,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    uploader, session_id, _ws = _host_upload(request, path)
    try:
        parsed = parse_upload_kind(kind)
    except RecordUploadError as exc:
        raise coded_exception_error(400, exc, code="record_upload_kind_invalid") from exc
    if parsed != UPLOAD_KIND_ROOM_TONE:
        raise coded_http_error(
            400, "only room_tone can be revoked", code="record_upload_kind_unrevocable"
        )
    uploader.revoke_room_tone(session_id, HOST_PARTICIPANT_ID)
    return {"revoked": True, "kind": UPLOAD_KIND_ROOM_TONE}


class RecordDiscardTakeBody(BaseModel):
    path: str
    take_index: int


@router.post("/api/record/land")
def post_host_record_land(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    try:
        return RecordControlService(ws).land()
    except FileNotFoundError as exc:
        raise coded_http_error(404, "no active record room", code="record_room_not_found") from exc
    except RecordTakeOpenError as exc:
        raise coded_http_error(409, str(exc), code=exc.code) from exc
    except (RecordLandingError, CodedValueError) as exc:
        raise coded_exception_error(400, exc, code="record_landing_refused") from exc


@router.post("/api/record/discard-take")
def post_host_record_discard_take(
    body: RecordDiscardTakeBody,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(body.path, request))
    try:
        return RecordControlService(ws).discard_take(body.take_index)
    except FileNotFoundError as exc:
        raise coded_http_error(404, "no active record room", code="record_room_not_found") from exc
    except RecordLandingError as exc:
        raise coded_exception_error(400, exc, code="record_discard_refused") from exc


class RecordAssignTrackBody(BaseModel):
    path: str
    participant_id: str
    track: str


@router.get("/api/record/tracks")
def get_host_record_tracks(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Host only: which track each recorded person lands on (never sent to guests)."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    try:
        return RecordControlService(ws).tracks()
    except FileNotFoundError as exc:
        raise coded_http_error(404, "no active record room", code="record_room_not_found") from exc


@router.post("/api/record/assign-track")
def post_host_record_assign_track(
    body: RecordAssignTrackBody,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(body.path, request))
    try:
        return RecordControlService(ws).assign_track(body.participant_id, body.track)
    except FileNotFoundError as exc:
        raise coded_http_error(404, "no active record room", code="record_room_not_found") from exc
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="unknown_track") from exc
    except ValueError as exc:
        raise coded_exception_error(409, exc, code="track_taken") from exc
