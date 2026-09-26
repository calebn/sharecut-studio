"""Host-authenticated record session HTTP twins."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.gui.routes.record_upload_http import UploadKindParam, ingest_record_upload_request
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.commands import RecordAuthzError
from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.record.landing import RecordLandingError
from podcast_mcp.services.record.reducer import RecordStateError, RoomFullError
from podcast_mcp.services.record.service import RecordSessionService
from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID
from podcast_mcp.services.record.upload import (
    UPLOAD_KIND_ROOM_TONE,
    RecordUploadError,
    RecordUploadService,
    parse_upload_kind,
)

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
        raise HTTPException(status_code=404, detail="no active record room")
    return RecordSessionService(ws.project, session_id=session_id).snapshot()


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
        raise HTTPException(status_code=404, detail="no active record room") from exc
    try:
        return ctrl.submit_host(body.command_type, body.payload)
    except RecordAuthzError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except (RecordStateError, RoomFullError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _host_upload(request: Request, path: str) -> tuple[RecordUploadService, str, ProjectWorkspace]:
    ws = ProjectWorkspace.open(resolve_project(path, request))
    session_id = RecordSessionService.active_session_id(ws.project)
    if not session_id:
        raise HTTPException(status_code=404, detail="no active record room")
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
    clipping: str | None = Query(
        None,
        max_length=4096,
        description="Segment-relative sample-peak clip spans a-b,c-d in ms; final part only.",
    ),
    kind: UploadKindParam = None,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    uploader, session_id, ws = _host_upload(request, path)
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
        workspace=ws,
        kind=kind,
    )


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
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if parsed != UPLOAD_KIND_ROOM_TONE:
        raise HTTPException(status_code=400, detail="only room_tone can be revoked")
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
        raise HTTPException(status_code=404, detail="no active record room") from exc
    except RecordLandingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
        raise HTTPException(status_code=404, detail="no active record room") from exc
    except RecordLandingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
