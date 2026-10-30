"""Share-scoped twins of owner routes: the one registry an Editor link may reach.

A route with no row here is denied: ``gui/routes/review_editor.py`` refuses to import with a
route that has no row. The HTTP twins are the registry; the guest MCP render tools are gated
separately in ``remote_mcp/allowlist.py`` and ``tools.py`` until they join it.
Only starting work spends host CPU, so only starts need ``needs_guest_render``; status, events and
cancel work with the flag off.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

from podcast_mcp.util.coded_error import CodedPermissionError


@dataclass(frozen=True)
class GuestRoute:
    """One twin: who may call it, how it is rate limited, and the host opt-ins it needs."""

    name: str
    method: Literal["GET", "POST"]
    path: str
    rate_kind: Literal["read", "mutate"]
    needs_guest_render: bool = False


_ROUTES = (
    GuestRoute(
        "render_preview",
        "POST",
        "/api/review/{token}/daw/render-preview",
        "mutate",
        needs_guest_render=True,
    ),
    GuestRoute(
        "render_preview_status",
        "GET",
        "/api/review/{token}/daw/render-preview/{job_id}",
        "read",
    ),
    GuestRoute(
        "pipeline_run",
        "POST",
        "/api/review/{token}/daw/pipeline/run",
        "mutate",
        needs_guest_render=True,
    ),
    GuestRoute("pipeline_status", "GET", "/api/review/{token}/daw/pipeline/status", "read"),
    GuestRoute(
        "pipeline_job_status", "GET", "/api/review/{token}/daw/pipeline/jobs/{job_id}", "read"
    ),
    GuestRoute(
        "pipeline_job_events",
        "GET",
        "/api/review/{token}/daw/pipeline/jobs/{job_id}/events",
        "read",
    ),
    GuestRoute(
        "pipeline_job_cancel",
        "POST",
        "/api/review/{token}/daw/pipeline/jobs/{job_id}/cancel",
        "mutate",
    ),
    GuestRoute(
        "export_start",
        "POST",
        "/api/review/{token}/daw/export",
        "mutate",
        needs_guest_render=True,
    ),
    GuestRoute("export_status", "GET", "/api/review/{token}/daw/export/status", "read"),
    GuestRoute("export_job_status", "GET", "/api/review/{token}/daw/export/jobs/{job_id}", "read"),
    GuestRoute(
        "export_job_events", "GET", "/api/review/{token}/daw/export/jobs/{job_id}/events", "read"
    ),
    GuestRoute(
        "export_job_cancel",
        "POST",
        "/api/review/{token}/daw/export/jobs/{job_id}/cancel",
        "mutate",
    ),
)

GUEST_OWNER_ROUTES: Mapping[str, GuestRoute] = MappingProxyType({r.name: r for r in _ROUTES})


def guest_owner_route(name: str) -> GuestRoute:
    """The registry row for *name*; a route with no row is denied."""
    row = GUEST_OWNER_ROUTES.get(name)
    if row is None:
        raise CodedPermissionError("route not shared with guests", code="share_capability_required")
    return row
