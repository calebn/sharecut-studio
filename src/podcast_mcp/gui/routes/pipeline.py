from __future__ import annotations

import json
from collections.abc import Iterator
from queue import Empty
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.jobs import PipelineJobManager
from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.gui.schemas import (
    PipelineAnalyzeRequest,
    PipelineCancelRequest,
    PipelineConfigPutRequest,
    PipelineRunRequest,
    RenderPreviewRequest,
)
from podcast_mcp.pipeline import STEP_NAMES
from podcast_mcp.services.pipeline_config import (
    build_config_payload,
    config_store,
    ensure_whisper_cached_for_run,
    merge_pipeline_config,
    skip_steps_from_enabled,
    suggest_pipeline_tuning,
)
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.whisper_models import WhisperWeightsMissingError

router = APIRouter()


def _jobs(request: Request) -> PipelineJobManager:
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
    config_store().put(
        project_path,
        config=req.config,
        enabled_steps=req.enabled_steps,
        unattended=req.unattended,
        reset=req.reset,
    )
    return build_config_payload(project_path)


@router.post("/api/pipeline/analyze")
def pipeline_analyze(
    req: PipelineAnalyzeRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(req.path, request)
    ws = ProjectWorkspace.open(project_path)
    working = config_store().get(project_path)
    result = suggest_pipeline_tuning(ws.project, base_config=working.config)
    if req.apply:
        config_store().put(project_path, config=result["proposed_config"])
        result["applied"] = True
        result["config"] = build_config_payload(project_path)
    else:
        result["applied"] = False
    return result


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
    if req.from_step and req.from_step not in STEP_NAMES:
        raise HTTPException(status_code=400, detail=f"Unknown from_step: {req.from_step}")
    if req.only_step and req.only_step not in STEP_NAMES:
        raise HTTPException(status_code=400, detail=f"Unknown only_step: {req.only_step}")
    if req.skip_steps:
        bad = [s for s in req.skip_steps if s not in STEP_NAMES]
        if bad:
            raise HTTPException(status_code=400, detail=f"Unknown skip_steps: {bad}")

    store = config_store()
    working = store.get(project_path) if req.use_working_set else None

    config = req.config
    if config is None and working is not None:
        config = working.config
    elif config is not None:
        config = merge_pipeline_config(config)

    unattended = req.unattended
    if unattended is None:
        unattended = working.unattended if working is not None else True

    skip_steps = req.skip_steps
    if skip_steps is None and req.enabled_steps is not None:
        skip_steps = skip_steps_from_enabled(req.enabled_steps)
    elif skip_steps is None and working is not None and working.enabled_steps is not None:
        skip_steps = skip_steps_from_enabled(working.enabled_steps)

    # Persist run choices into working set for agent/GUI parity
    if req.use_working_set:
        store.put(
            project_path,
            config=config,
            enabled_steps=req.enabled_steps,
            unattended=unattended,
        )

    try:
        ensure_whisper_cached_for_run(
            config=config,
            from_step=req.from_step,
            only_step=req.only_step,
            skip_steps=skip_steps,
        )
    except WhisperWeightsMissingError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    try:
        job = jobs.start(
            project_path,
            from_step=req.from_step,
            only_step=req.only_step,
            skip_steps=skip_steps,
            unattended=bool(unattended),
            config=config,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job": job.snapshot()}


@router.post("/api/pipeline/cancel")
def pipeline_cancel(
    req: PipelineCancelRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    job = _jobs(request).cancel(req.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No pipeline job")
    return {"job": job.snapshot()}


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
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job": job.snapshot()}


@router.get("/api/pipeline/events")
def pipeline_events(
    request: Request,
    job_id: str | None = Query(None),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> StreamingResponse:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    job = _jobs(request).get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="No pipeline job")

    def event_stream() -> Iterator[str]:
        jobs = _jobs(request)
        subscribed = jobs.add_sse_subscriber_for(job)
        try:
            snap = job.snapshot()
            yield f"data: {json.dumps({'type': 'status', 'job': snap})}\n\n"
            if snap["status"] in ("ok", "error", "cancelled"):
                yield f"data: {json.dumps({'type': 'done', 'job': snap})}\n\n"
                return
            while True:
                try:
                    item = job.events.get(timeout=1.0)
                except Empty:
                    late = job.snapshot()
                    if late["status"] in ("ok", "error", "cancelled"):
                        yield f"data: {json.dumps({'type': 'done', 'job': late})}\n\n"
                        return
                    yield f"data: {json.dumps({'type': 'status', 'job': late})}\n\n"
                    continue
                if item is None:
                    break
                yield f"data: {json.dumps(item)}\n\n"
                if item.get("type") == "done":
                    break
        finally:
            if subscribed:
                jobs.remove_sse_subscriber(job)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
