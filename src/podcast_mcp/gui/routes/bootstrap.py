"""GUI routes for first-run bootstrap (status + download job + SSE)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from queue import Empty
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.bootstrap_jobs import BootstrapJobManager, shared_bootstrap_job_manager
from podcast_mcp.gui.routes.deps import require_host
from podcast_mcp.gui.schemas import BootstrapCancelRequest, BootstrapRunRequest
from podcast_mcp.services.bootstrap import component_status
from podcast_mcp.whisper_models import resolve_whisper_model

router = APIRouter()


def _jobs(request: Request) -> BootstrapJobManager:
    mgr = getattr(request.app.state, "bootstrap_jobs", None)
    if mgr is None:
        mgr = shared_bootstrap_job_manager()
        request.app.state.bootstrap_jobs = mgr
    return mgr


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
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
        job = mgr.start(
            components=req.components,
            whisper_model=model,
            force=req.force,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"job": job.snapshot()}


@router.post("/api/bootstrap/cancel")
def bootstrap_cancel(
    req: BootstrapCancelRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    job = _jobs(request).cancel(req.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No bootstrap job")
    return {"job": job.snapshot()}


@router.get("/api/bootstrap/status-job")
def bootstrap_job_status(
    request: Request,
    job_id: str | None = Query(None),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    job = _jobs(request).get_job(job_id)
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
    job = _jobs(request).get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No bootstrap job")

    def event_stream() -> Iterator[str]:
        yield f"data: {json.dumps({'type': 'status', 'job': job.snapshot()})}\n\n"
        while True:
            try:
                event = job.events.get(timeout=1.0)
            except Empty:
                yield f"data: {json.dumps({'type': 'status', 'job': job.snapshot()})}\n\n"
                if job.status not in ("queued", "running"):
                    break
                continue
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("type") == "done":
                break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
