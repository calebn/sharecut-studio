"""GUI routes for first-run bootstrap (status + download job + SSE)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    coded_http_error,
)
from podcast_mcp.gui.routes.sse_common import job_events_response
from podcast_mcp.gui.schemas import BootstrapCancelRequest, BootstrapRunRequest
from podcast_mcp.services.jobs import BootstrapSlotBusyError, JobManager, JobSlotBusyError
from podcast_mcp.services.pipeline import (
    component_status,
    resolve_whisper_model,
    uninstall_model,
)
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


@router.get("/api/bootstrap/status")
def bootstrap_status(whisper_model: str | None = Query(None)) -> dict[str, Any]:
    try:
        return component_status(whisper_model=whisper_model)
    except ValueError as exc:
        raise bad_request_error(exc) from exc


@router.post("/api/bootstrap/run")
def bootstrap_run(
    req: BootstrapRunRequest,
    request: Request,
) -> dict[str, Any]:
    mgr = _jobs(request)
    try:
        model = resolve_whisper_model(requested=req.whisper_model)
        job, adopted = mgr.start_bootstrap(
            components=req.components,
            whisper_model=model,
            force=req.force,
        )
    except BootstrapSlotBusyError as exc:
        raise coded_http_error(
            409,
            {"detail": str(exc), "running": exc.running, "cancelling": exc.cancelling},
            code=exc.code,
        ) from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc
    return {"job": job.snapshot(), "adopted": adopted}


@router.delete("/api/bootstrap/models/{model_id}")
def bootstrap_remove_model(
    model_id: str,
    request: Request,
    whisper_model: str | None = Query(None),
) -> dict[str, Any]:
    """Delete one downloaded model (one Whisper size). Refused while a download or job runs."""
    mgr = _jobs(request)
    try:
        with mgr.model_removal():
            return dict(uninstall_model(model_id, whisper_model))
    except BootstrapSlotBusyError as exc:
        raise coded_http_error(
            409,
            {
                "detail": str(exc),
                "running": exc.running,
                "cancelling": exc.cancelling,
            },
            code=exc.code,
        ) from exc
    except JobSlotBusyError as exc:
        raise coded_http_error(409, str(exc), code="pipeline_busy") from exc
    except CodedValueError as exc:
        refused = exc.code == "model_not_removable"
        raise coded_exception_error(409 if refused else 400, exc, code="invalid_request") from exc


@router.post("/api/bootstrap/cancel")
def bootstrap_cancel(
    req: BootstrapCancelRequest,
    request: Request,
) -> dict[str, Any]:
    job = _jobs(request).cancel_bootstrap(req.job_id)
    if job is None:
        raise coded_http_error(404, "No bootstrap job", code="bootstrap_job_not_found")
    return {"job": job.snapshot()}


@router.get("/api/bootstrap/status-job")
def bootstrap_job_status(
    request: Request,
    job_id: str | None = Query(None),
) -> dict[str, Any]:
    job = _jobs(request).get_bootstrap_job(job_id)
    if job is None:
        return {"job": None}
    return {"job": job.snapshot()}


@router.get("/api/bootstrap/events")
def bootstrap_events(
    request: Request,
    job_id: str | None = Query(None),
) -> StreamingResponse:
    job = _jobs(request).get_bootstrap_job(job_id)
    if job is None:
        raise coded_http_error(404, "No bootstrap job", code="bootstrap_job_not_found")
    return job_events_response(job)
