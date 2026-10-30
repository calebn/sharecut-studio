from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    require_host,
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
    PipelineRunRequest,
    RenderPreviewRequest,
)
from podcast_mcp.pipeline import STEP_NAMES
from podcast_mcp.services.jobs import JobManager
from podcast_mcp.services.pipeline import (
    build_config_payload,
    config_store,
    merge_pipeline_config,
)

router = APIRouter()


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


@router.get("/api/pipeline/steps")
def pipeline_steps() -> dict[str, Any]:
    return {"steps": list(STEP_NAMES)}


@router.get("/api/pipeline/config")
def pipeline_get_config(
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    return build_config_payload(project_path)


@router.put("/api/pipeline/config")
def pipeline_put_config(
    req: PipelineConfigPutRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
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


@router.post("/api/pipeline/analyze")
def pipeline_analyze(
    req: PipelineAnalyzeRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Heuristic Analyze as a ``kind=analyze`` pipeline-slot job (progress via ``/events``)."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(req.path, request)
    try:
        job = _jobs(request).start_analyze(project_path, apply=req.apply)
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="pipeline_busy") from exc
    return {"job": job.snapshot()}


@router.get("/api/pipeline/status")
def pipeline_status(
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    served = getattr(request.app.state, "served_project", None)
    return _jobs(request).status(project_path=str(served) if served is not None else None)


@router.post("/api/pipeline/run")
def pipeline_run(
    req: PipelineRunRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
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


@router.post("/api/pipeline/cancel")
def pipeline_cancel(
    req: PipelineCancelRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    return {"job": cancel_job(_jobs(request), req.job_id).snapshot()}


@router.post("/api/pipeline/render-preview")
def pipeline_render_preview(
    req: RenderPreviewRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Rebuild stems/premix (``PipelineService.render_preview``) as a background job."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    jobs = _jobs(request)
    project_path = resolve_project(req.path, request)
    try:
        job = jobs.start_render_preview(project_path)
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="pipeline_busy") from exc
    return {"job": job.snapshot()}


@router.get("/api/pipeline/events")
def pipeline_events(
    request: Request,
    job_id: str | None = Query(None),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> StreamingResponse:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    return job_events_response(find_job(_jobs(request), job_id))
