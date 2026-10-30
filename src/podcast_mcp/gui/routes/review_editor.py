"""Editor-only twins of owner routes, under ``/api/review/{token}/daw/*``.

Each twin is a row in ``GUEST_OWNER_ROUTES``, reached through ``guest_route(name)``. No handler
takes a path from the client.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from podcast_mcp.gui.job_events import GUEST_STREAM_SLOTS
from podcast_mcp.gui.routes.deps import coded_http_error
from podcast_mcp.gui.routes.guest_errors import guest_boundary
from podcast_mcp.gui.routes.pipeline_jobs import (
    cancel_job,
    check_steps,
    resolve_skip_steps,
    start_pipeline_job,
)
from podcast_mcp.gui.routes.share_common import check_share_token, rate_limit_share
from podcast_mcp.gui.routes.sse_common import guest_job_events_response
from podcast_mcp.gui.schemas import GuestPipelineRunRequest
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import (
    GUEST_OWNER_ROUTES,
    GuestRoute,
    guest_owner_route,
    require_share_edit,
)
from podcast_mcp.services.jobs import (
    GUEST_PIPELINE_KINDS,
    GUEST_RENDER_KINDS,
    Job,
    guest_job_view,
    guest_status_view,
    guest_visible_job,
)
from podcast_mcp.services.pipeline import WordAlignerMissingError, config_store
from podcast_mcp.util.coded_error import guest_message_for_code
from podcast_mcp.util.guest_render import require_guest_render

router = APIRouter()
log = logging.getLogger(__name__)


def guest_route(name: str) -> Callable[[str], ProjectWorkspace]:
    """Dependency for the twin registered as *name*; returns the share's workspace.

    An unregistered name fails at import, so a twin cannot be mounted without a row.
    """
    row = guest_owner_route(name)

    def dependency(token: str) -> ProjectWorkspace:
        check_share_token(token)
        rate_limit_share(token, row.rate_kind)
        with guest_boundary(log, "review request"):
            if row.needs_guest_render:
                require_guest_render()
            _row, ws = require_share_edit(token)
        return ws

    dependency.guest_route_name = name  # type: ignore[attr-defined]
    return dependency


JOB_NOT_FOUND = "Job not found"
STREAMS_FULL = "Too many open streams on this link"
STEP_NOT_SHARED = "That step is not available on a share link."
RUN_ATTENDED = "The host set this project to attended runs; ask the host to start it."
GUEST_BLOCKED_STEPS = frozenset({"export_deliverables"})


@dataclass(frozen=True)
class GuestJobScope:
    ws: ProjectWorkspace
    job: Job
    kinds: frozenset[str]


def guest_job_route(
    name: str, kinds: frozenset[str]
) -> Callable[[str, str, Request], GuestJobScope]:
    """Like ``guest_route``, for a ``{job_id}`` route: the job is the share's or it is a 404.

    An unknown id, another project's job, a job of a kind this route does not serve and a job
    with no project all answer alike, so the route says nothing about which jobs exist.
    """
    workspace = guest_route(name)

    def dependency(token: str, job_id: str, request: Request) -> GuestJobScope:
        ws = workspace(token)
        with guest_boundary(log, "review job lookup"):
            job = guest_visible_job(request.app.state.jobs.get_job(job_id), ws.path, kinds)
        if job is None:
            raise coded_http_error(404, JOB_NOT_FOUND, code="job_not_found")
        return GuestJobScope(ws, job, kinds)

    dependency.guest_route_name = name  # type: ignore[attr-defined]
    return dependency


RenderPreviewWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("render_preview"))]
PipelineRunWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("pipeline_run"))]
PipelineStatusWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("pipeline_status"))]
RenderPreviewStatusScope = Annotated[
    GuestJobScope, Depends(guest_job_route("render_preview_status", GUEST_RENDER_KINDS))
]
PipelineJobScope = Annotated[
    GuestJobScope, Depends(guest_job_route("pipeline_job_status", GUEST_PIPELINE_KINDS))
]
PipelineEventsScope = Annotated[
    GuestJobScope, Depends(guest_job_route("pipeline_job_events", GUEST_PIPELINE_KINDS))
]
PipelineCancelScope = Annotated[
    GuestJobScope, Depends(guest_job_route("pipeline_job_cancel", GUEST_PIPELINE_KINDS))
]


def _projected(job: Job, scope: GuestJobScope) -> dict[str, Any]:
    projected = guest_job_view(job, scope.ws.path, scope.kinds)
    if projected is None:
        raise coded_http_error(404, JOB_NOT_FOUND, code="job_not_found")
    return {"job": projected}


@router.post("/api/review/{token}/daw/render-preview", status_code=202)
def post_daw_render_preview(request: Request, ws: RenderPreviewWorkspace) -> dict[str, Any]:
    """Uses the same ``JobManager`` lock as the host GUI so concurrent host and guest renders cannot race."""
    with guest_boundary(log, "review render"):
        job = request.app.state.jobs.start_render_preview(ws.path)

    projected = guest_job_view(job, ws.path, GUEST_RENDER_KINDS)
    if projected is None:
        raise coded_http_error(
            500, "Render preview job unavailable", code="render_preview_job_unavailable"
        )
    return {"job": projected}


@router.get("/api/review/{token}/daw/render-preview/{job_id}")
def get_daw_render_preview(scope: RenderPreviewStatusScope) -> dict[str, Any]:
    return _projected(scope.job, scope)


@router.post("/api/review/{token}/daw/pipeline/run", status_code=202)
def post_daw_pipeline_run(
    request: Request, req: GuestPipelineRunRequest, ws: PipelineRunWorkspace
) -> dict[str, Any]:
    """Runs the host's working-set config for this project and never writes it."""
    with guest_boundary(log, "review pipeline run"):
        check_steps(req.from_step, req.only_step, req.skip_steps)
        if {req.from_step, req.only_step} & GUEST_BLOCKED_STEPS:
            raise coded_http_error(400, STEP_NOT_SHARED, code="pipeline_step_not_shared")
        working = config_store().get(ws.path, stage=False)
        if not working.unattended:
            raise coded_http_error(409, RUN_ATTENDED, code="pipeline_attended")
        skip_steps = resolve_skip_steps(req.skip_steps, working.enabled_steps)
        skip_steps = [*(skip_steps or []), *sorted(GUEST_BLOCKED_STEPS - set(skip_steps or []))]
        try:
            job = start_pipeline_job(
                request.app.state.jobs,
                ws.path,
                config=working.config,
                from_step=req.from_step,
                only_step=req.only_step,
                skip_steps=skip_steps,
                unattended=True,
                force_transcribe=req.force_transcribe,
                overwrite_edited=False,
                retime_words=req.retime_words,
            )
        except WordAlignerMissingError as exc:
            log.info("guest pipeline run refused: word aligner unusable", exc_info=exc)
            raise coded_http_error(
                409, guest_message_for_code("model_needed"), code="model_needed"
            ) from exc

    projected = guest_job_view(job, ws.path, GUEST_PIPELINE_KINDS)
    if projected is None:
        raise coded_http_error(500, "Pipeline job unavailable", code="pipeline_job_unavailable")
    return {"job": projected}


@router.get("/api/review/{token}/daw/pipeline/status")
def get_daw_pipeline_status(request: Request, ws: PipelineStatusWorkspace) -> dict[str, Any]:
    with guest_boundary(log, "review pipeline status"):
        return guest_status_view(request.app.state.jobs.status(), ws.path, GUEST_PIPELINE_KINDS)


@router.get("/api/review/{token}/daw/pipeline/jobs/{job_id}")
def get_daw_pipeline_job(scope: PipelineJobScope) -> dict[str, Any]:
    return _projected(scope.job, scope)


@router.get("/api/review/{token}/daw/pipeline/jobs/{job_id}/events")
def get_daw_pipeline_job_events(token: str, scope: PipelineEventsScope) -> StreamingResponse:
    lease = GUEST_STREAM_SLOTS.acquire(token)
    if lease is None:
        raise coded_http_error(429, STREAMS_FULL, code="rate_limited", headers={"Retry-After": "5"})

    def still_shared() -> bool:
        try:
            _row, current = require_share_edit(token)
        except Exception:
            log.info("guest event stream closed: share no longer reachable", exc_info=True)
            return False
        return current.path == scope.ws.path

    try:
        return guest_job_events_response(
            scope.job, scope.ws.path, scope.kinds, lease=lease, still_shared=still_shared
        )
    except BaseException:
        lease.release()
        raise


@router.post("/api/review/{token}/daw/pipeline/jobs/{job_id}/cancel")
def post_daw_pipeline_job_cancel(request: Request, scope: PipelineCancelScope) -> dict[str, Any]:
    """Runs with ``PODCAST_GUEST_RENDER`` off, so the host can stop a job after turning it off."""
    with guest_boundary(log, "review pipeline cancel"):
        job = cancel_job(request.app.state.jobs, scope.job.id, detail=JOB_NOT_FOUND)
    return _projected(job, scope)


def check_guest_router(router: APIRouter, registry: Mapping[str, GuestRoute]) -> None:
    """Refuse a router with a route that lacks a registered ``guest_route`` or differs from its
    row, and a row with no route."""
    mounted: set[str] = set()
    for route in router.routes:
        names = [
            name
            for dep in route.dependant.dependencies  # type: ignore[attr-defined]
            if (name := getattr(dep.call, "guest_route_name", None))
        ]
        if len(names) != 1 or names[0] not in registry:
            raise RuntimeError(f"{route.path} has no registered guest_route dependency")  # type: ignore[attr-defined]
        row = registry[names[0]]
        if route.path != row.path or route.methods != {row.method}:  # type: ignore[attr-defined]
            raise RuntimeError(f"{route.path} does not match the {row.name} row")  # type: ignore[attr-defined]
        mounted.add(names[0])
    if mounted != set(registry):
        raise RuntimeError(f"guest routes without a handler: {sorted(set(registry) - mounted)}")


check_guest_router(router, GUEST_OWNER_ROUTES)
