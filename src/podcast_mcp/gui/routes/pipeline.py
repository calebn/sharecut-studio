from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    host_gate,
    resolve_project,
)
from podcast_mcp.gui.routes.pipeline_jobs import (
    cancel_job,
    check_steps,
    find_job,
    owner_busy_error,
    resolve_skip_steps,
    start_pipeline_job,
)
from podcast_mcp.gui.routes.sse_common import job_events_response
from podcast_mcp.gui.schemas import (
    PipelineAnalyzeRequest,
    PipelineCancelRequest,
    PipelineConfigPutRequest,
    PipelineRetryRequest,
    PipelineRunRequest,
    RenderPreviewRequest,
)
from podcast_mcp.pipeline import STEP_NAMES
from podcast_mcp.services.jobs import JobManager, JobSlotBusyError
from podcast_mcp.services.pipeline import (
    build_config_payload,
    config_store,
    merge_pipeline_config,
)
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()
_HOST_GATE = [Depends(host_gate)]


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


@router.get("/api/pipeline/steps")
def pipeline_steps() -> dict[str, Any]:
    return {"steps": list(STEP_NAMES)}


@router.get("/api/pipeline/config", dependencies=_HOST_GATE)
def pipeline_get_config(
    request: Request,
    path: str = Query(...),
) -> dict[str, Any]:
    project_path = resolve_project(path, request)
    return build_config_payload(project_path)


@router.put("/api/pipeline/config", dependencies=_HOST_GATE)
def pipeline_put_config(
    req: PipelineConfigPutRequest,
    request: Request,
) -> dict[str, Any]:
    project_path = resolve_project(req.path, request)
    try:
        config_store().put(
            project_path,
            config=req.config,
            enabled_steps=req.enabled_steps,
            unattended=req.unattended,
            reset=req.reset,
        )
    except ValueError as exc:
        raise bad_request_error(exc) from exc
    return build_config_payload(project_path)


@router.post("/api/pipeline/analyze", dependencies=_HOST_GATE)
def pipeline_analyze(
    req: PipelineAnalyzeRequest,
    request: Request,
) -> dict[str, Any]:
    """Heuristic Analyze as a ``kind=analyze`` pipeline-slot job (progress via ``/events``)."""
    project_path = resolve_project(req.path, request)
    try:
        job = _jobs(request).start_analyze(project_path, apply=req.apply)
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="pipeline_busy") from exc
    return {"job": job.snapshot()}


@router.get("/api/pipeline/status", dependencies=_HOST_GATE)
def pipeline_status(
    request: Request,
) -> dict[str, Any]:
    served = getattr(request.app.state, "served_project", None)
    return _jobs(request).status(project_path=str(served) if served is not None else None)


@router.post("/api/pipeline/retry", dependencies=_HOST_GATE)
def pipeline_retry(
    req: PipelineRetryRequest,
    request: Request,
) -> dict[str, Any]:
    project_path = resolve_project(req.path, request)
    try:
        job = _jobs(request).retry_pipeline(project_path, req.job_id)
    except CodedValueError as exc:
        status = 404 if exc.code == "pipeline_retry_unavailable" else 409
        raise coded_exception_error(status, exc, code="pipeline_retry_unavailable") from exc
    except JobSlotBusyError as exc:
        raise owner_busy_error(exc) from exc
    return {"job": job.snapshot()}


@router.post("/api/pipeline/run", dependencies=_HOST_GATE)
def pipeline_run(
    req: PipelineRunRequest,
    request: Request,
) -> dict[str, Any]:
    jobs = _jobs(request)
    project_path = resolve_project(req.path, request)
    check_steps(req.from_step, req.only_step, req.skip_steps)

    store = config_store()
    working = store.get(project_path) if req.use_working_set else None

    config = req.config
    if config is None and working is not None:
        config = working.config
    elif config is not None:
        try:
            config = merge_pipeline_config(config)
        except ValueError as exc:
            raise bad_request_error(exc) from exc

    unattended = req.unattended
    if unattended is None:
        unattended = working.unattended if working is not None else True

    skip_steps = resolve_skip_steps(
        req.skip_steps, req.enabled_steps, working.enabled_steps if working is not None else None
    )

    def persist() -> None:
        store.put(
            project_path,
            config=config,
            enabled_steps=req.enabled_steps,
            unattended=unattended,
        )

    job = start_pipeline_job(
        jobs,
        project_path,
        config=config,
        from_step=req.from_step,
        only_step=req.only_step,
        skip_steps=skip_steps,
        unattended=bool(unattended),
        force_transcribe=req.force_transcribe,
        overwrite_edited=req.overwrite_edited,
        retime_words=req.retime_words,
        persist=persist if req.use_working_set else None,
        busy_error=owner_busy_error,
    )
    return {"job": job.snapshot()}


@router.post("/api/pipeline/cancel", dependencies=_HOST_GATE)
def pipeline_cancel(
    req: PipelineCancelRequest,
    request: Request,
) -> dict[str, Any]:
    return {"job": cancel_job(_jobs(request), req.job_id).snapshot()}


@router.post("/api/pipeline/render-preview", dependencies=_HOST_GATE)
def pipeline_render_preview(
    req: RenderPreviewRequest,
    request: Request,
) -> dict[str, Any]:
    """Rebuild stems/premix (``PipelineService.render_preview``) as a background job."""
    jobs = _jobs(request)
    project_path = resolve_project(req.path, request)
    try:
        job = jobs.start_render_preview(project_path)
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="pipeline_busy") from exc
    return {"job": job.snapshot()}


@router.get("/api/pipeline/events", dependencies=_HOST_GATE)
def pipeline_events(
    request: Request,
    job_id: str | None = Query(None),
) -> StreamingResponse:
    return job_events_response(find_job(_jobs(request), job_id))
