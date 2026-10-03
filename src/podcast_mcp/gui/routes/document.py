"""Document commands, comments and atomic state over HTTP."""

from __future__ import annotations

import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request
from filelock import Timeout
from pydantic import BaseModel

from podcast_mcp.edits.range_edits import RangeChangedError
from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.gui.routes.deps import (
    peer_host,
    project_busy_http_error,
    require_authz,
    resolve_project,
)
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import DocumentCommandRequest
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.services.document_sync import (
    DocumentConflictError,
    DocumentSyncService,
    document_command_from_body,
)
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
        return svc.submit(cmd, structural_mode=body.structural_mode, range_policy="host_apply")
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


class RangeAudioInput(BaseModel):
    model_config = {"extra": "forbid"}
    target: ExactRangeTarget
    action: Literal["play"] = "play"


@router.post("/api/range-audio")
def range_audio(
    body: RangeAudioInput,
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    from podcast_mcp.gui.audio import pinned_audio_response
    from podcast_mcp.gui.routes.deps import require_host
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService

    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    try:
        audio = PlayService(ws).play_selected_range(body.target)
        return pinned_audio_response(audio, media_type="audio/wav", filename=audio.name)
    except RangeChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/api/pending-preview")
def pending_preview_audio(
    request: Request,
    path: str = Query(...),
    edit_id: str = Query(...),
    mode: Literal["current", "suggested", "ab"] = Query("suggested"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    from podcast_mcp.gui.audio import pinned_audio_response
    from podcast_mcp.gui.routes.deps import require_host
    from podcast_mcp.services.app import ProjectWorkspace
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.util.project_state import render_lock

    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    try:
        with render_lock(ws.project), ws.transaction():
            audio = (
                PlayService(ws)
                .play_pending_preview(
                    edit_id, mode=mode, source="premix", dry_run=True, rerender=True
                )
                .wav_path
            )
            return pinned_audio_response(audio, media_type="audio/wav", filename=audio.name)
    except RangeChangedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Timeout as exc:
        busy = project_busy_http_error(exc)
        if busy is None:
            raise
        raise busy from exc
