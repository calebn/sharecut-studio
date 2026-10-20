from __future__ import annotations

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel

from podcast_mcp.gui.audio import audio_file_response
from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    require_host,
    resolve_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    BoundaryEdit,
    BoundaryTarget,
    ClipGeometry,
    EditService,
    PlayService,
)
from podcast_mcp.services.document_sync import DocumentConflictError

router = APIRouter()


class BoundaryContextInput(BaseModel):
    target: BoundaryTarget
    expected_geometry: list[ClipGeometry]


class BoundaryContextRequest(BoundaryContextInput):
    path: str


class BoundaryAuditionRequest(BaseModel):
    path: str
    target: BoundaryTarget
    edit: BoundaryEdit
    expected_token: str
    pad_sec: float = 0.75


@router.post("/api/boundary/context")
def post_boundary_context(
    body: BoundaryContextRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(body.path, request))
    try:
        with ws.transaction():
            context = EditService(ws).boundary_context(
                body.target, expected_geometry=body.expected_geometry
            )
        return context.model_dump()
    except DocumentConflictError as exc:
        raise coded_exception_error(409, exc, code="document_conflict") from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc


@router.post("/api/boundary/audition")
def post_boundary_audition(
    body: BoundaryAuditionRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(body.path, request))
    try:
        return (
            PlayService(ws)
            .audition_boundary(body.target, body.edit, body.expected_token, pad_sec=body.pad_sec)
            .model_dump()
        )
    except DocumentConflictError as exc:
        raise coded_exception_error(409, exc, code="document_conflict") from exc
    except FileNotFoundError as exc:
        raise coded_exception_error(404, exc, code="boundary_audio_not_found") from exc
    except (ValueError, KeyError) as exc:
        raise coded_exception_error(400, exc, code="invalid_request") from exc


@router.get("/api/boundary/audition/{opaque_id}/{side}")
def get_boundary_audition_audio(
    opaque_id: str,
    side: str,
    request: Request,
    expected_token: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    try:
        project_path = PlayService.issued_boundary_project(opaque_id)
        ws = ProjectWorkspace.open(resolve_project(str(project_path), request))
        path = PlayService(ws).boundary_audio_path(opaque_id, side, expected_token)
        return audio_file_response(path, request=request)
    except DocumentConflictError as exc:
        raise coded_exception_error(409, exc, code="document_conflict") from exc
    except FileNotFoundError as exc:
        raise coded_exception_error(404, exc, code="boundary_audio_not_found") from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc
