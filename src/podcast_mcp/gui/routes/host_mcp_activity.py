"""Host-only report of when an app last used the host ``/mcp`` address.

Include-time ``host_gate`` guards this router (see ``server.py``). The answer is
process-lifetime memory only: it resets when Studio restarts. ``/mcp`` is stateless, so
"used" means a request got a 2xx answer, never that a client is still attached.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from podcast_mcp.gui.routes.deps import NO_STORE

router = APIRouter()


class HostMcpActivityResponse(BaseModel):
    mounted: bool
    last_request_at: str | None
    age_seconds: int | None


@router.get("/api/host-mcp/activity", response_model=HostMcpActivityResponse)
def host_mcp_activity(request: Request) -> Any:
    state = request.app.state
    mounted = getattr(state, "host_mcp_session_manager", None) is not None
    activity = getattr(state, "host_mcp_activity", None)
    age, wall = activity.snapshot() if mounted and activity is not None else (None, None)
    body = HostMcpActivityResponse(
        mounted=mounted,
        last_request_at=(
            datetime.fromtimestamp(wall, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            if wall is not None
            else None
        ),
        age_seconds=int(age) if age is not None else None,
    )
    return JSONResponse(body.model_dump(), headers=NO_STORE)
