"""Editor-only twins of owner routes, under ``/api/review/{token}/daw/*``.

Each twin is a row in ``GUEST_OWNER_ROUTES``, reached through ``guest_route(name)``. No handler
takes a path from the client.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request

from podcast_mcp.gui.routes.deps import coded_http_error
from podcast_mcp.gui.routes.guest_errors import guest_boundary
from podcast_mcp.gui.routes.share_common import check_share_token, rate_limit_share
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import (
    GUEST_OWNER_ROUTES,
    GuestRoute,
    guest_owner_route,
    require_share_edit,
)
from podcast_mcp.services.jobs import guest_job_view
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


RENDER_JOB_NOT_FOUND = "Render preview job not found"
RenderPreviewWorkspace = Annotated[ProjectWorkspace, Depends(guest_route("render_preview"))]
RenderPreviewStatusWorkspace = Annotated[
    ProjectWorkspace, Depends(guest_route("render_preview_status"))
]


@router.post("/api/review/{token}/daw/render-preview", status_code=202)
def post_daw_render_preview(request: Request, ws: RenderPreviewWorkspace) -> dict[str, Any]:
    """Uses the same ``JobManager`` lock as the host GUI so concurrent host and guest renders cannot race."""
    with guest_boundary(log, "review render"):
        job = request.app.state.jobs.start_render_preview(ws.path)

    projected = guest_job_view(job, ws.path)
    if projected is None:
        raise coded_http_error(
            500, "Render preview job unavailable", code="render_preview_job_unavailable"
        )
    return {"job": projected}


@router.get("/api/review/{token}/daw/render-preview/{job_id}")
def get_daw_render_preview(
    job_id: str, request: Request, ws: RenderPreviewStatusWorkspace
) -> dict[str, Any]:
    with guest_boundary(log, "review render status"):
        projected = guest_job_view(request.app.state.jobs.get_job(job_id), ws.path)
    if projected is None:
        raise coded_http_error(404, RENDER_JOB_NOT_FOUND, code="job_not_found")
    return {"job": projected}


def check_guest_router(router: APIRouter, registry: Mapping[str, GuestRoute]) -> None:
    """Refuse a router with a route that lacks a registered ``guest_route`` or a row with no route."""
    mounted: set[str] = set()
    for route in router.routes:
        names = [
            name
            for dep in route.dependant.dependencies  # type: ignore[attr-defined]
            if (name := getattr(dep.call, "guest_route_name", None))
        ]
        if len(names) != 1 or names[0] not in registry:
            raise RuntimeError(f"{route.path} has no registered guest_route dependency")  # type: ignore[attr-defined]
        mounted.add(names[0])
    if mounted != set(registry):
        raise RuntimeError(f"guest routes without a handler: {sorted(set(registry) - mounted)}")


check_guest_router(router, GUEST_OWNER_ROUTES)
