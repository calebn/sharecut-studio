"""GUI routes for first-run bootstrap (status + download job + SSE)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    coded_http_error,
    require_host,
)
from podcast_mcp.gui.routes.sse_common import job_events_response
from podcast_mcp.gui.schemas import BootstrapCancelRequest, BootstrapRunRequest
from podcast_mcp.services.jobs import JobManager
from podcast_mcp.services.pipeline import component_status, resolve_whisper_model

router = APIRouter()


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


@router.get("/api/bootstrap/status")
def bootstrap_status(
    request: Request,
    whisper_model: str | None = Query(None),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    try:
        return component_status(whisper_model=whisper_model)
    except ValueError as exc:
        raise bad_request_error(exc) from exc


@router.post("/api/bootstrap/run")
def bootstrap_run(
    req: BootstrapRunRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    mgr = _jobs(request)
    try:
        model = resolve_whisper_model(requested=req.whisper_model)
        job = mgr.start_bootstrap(
            components=req.components,
            whisper_model=model,
            force=req.force,
        )
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="bootstrap_job_running") from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc
    return {"job": job.snapshot()}


@router.post("/api/bootstrap/cancel")
def bootstrap_cancel(
    req: BootstrapCancelRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    job = _jobs(request).cancel_bootstrap(req.job_id)
    if job is None:
        raise coded_http_error(404, "No bootstrap job", code="bootstrap_job_not_found")
    return {"job": job.snapshot()}


@router.get("/api/bootstrap/status-job")
def bootstrap_job_status(
    request: Request,
    job_id: str | None = Query(None),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    job = _jobs(request).get_bootstrap_job(job_id)
    if job is None:
        return {"job": None}
    return {"job": job.snapshot()}


@router.get("/api/bootstrap/events")
def bootstrap_events(
    request: Request,
    job_id: str | None = Query(None),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> StreamingResponse:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    job = _jobs(request).get_bootstrap_job(job_id)
    if job is None:
        raise coded_http_error(404, "No bootstrap job", code="bootstrap_job_not_found")
    return job_events_response(job)
