"""Host export / bounce HTTP adapters over BounceService + PipelineService."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from podcast_mcp.gui.jobs import PipelineJobManager
from podcast_mcp.gui.routes.deps import peer_host, require_authz, resolve_project
from podcast_mcp.gui.schemas import BounceRequestBody, ExportDeliverablesRequest

router = APIRouter()


def _jobs(request: Request) -> PipelineJobManager:
    return request.app.state.jobs


def _auth(
    request: Request,
    *,
    token: str | None = None,
    x_podcast_token: str | None = None,
) -> None:
    require_authz(
        client_id="viewer",
        role="viewer",
        peer_host=peer_host(request),
        token=token or x_podcast_token,
    )


@router.post("/api/export/bounce")
def export_bounce(
    body: BounceRequestBody,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    _auth(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    try:
        job = _jobs(request).start_bounce(
            project_path,
            track_ids=body.track_ids,
            start_s=body.start_s,
            end_s=body.end_s,
            formats=body.formats,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    snap = job.snapshot()
    return {"job_id": job.id, "job": snap}


@router.post("/api/export/deliverables")
def export_deliverables(
    body: ExportDeliverablesRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Same PipelineService.export_audio path used by MCP/CLI master export."""
    _auth(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    try:
        job = _jobs(request).start_export(project_path, formats=body.formats)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    snap = job.snapshot()
    return {"job_id": job.id, "job": snap}
